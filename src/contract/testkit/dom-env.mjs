/**
 * dom-env.mjs — the HEADLESS DOM environment for bootHeadlessGame().
 * ============================================================================
 *
 * Phaser was written for a browser. To boot the REAL engine under Node we give
 * it a DOM (jsdom) plus FIVE surgical shims for the exact places the headless
 * NullRenderer + Node's jsdom diverge from a real browser. Each shim is a NAMED,
 * COMMENTED function below — NOT inline magic — so a future Phaser bump that
 * breaks one fails LOUDLY at a named seam (and the smoke canary catches it).
 *
 * THE FIVE LOAD-BEARING PROBLEMS (each solved by one named patch):
 *   (1) jsdom DOM globals must land on globalThis (Node 24 getter-only props).
 *   (2) texture boot-load — Phaser's TextureManager.boot() decodes base64 data
 *       URIs (__DEFAULT/__MISSING/__WHITE) via `new Image()`; jsdom's Image does
 *       NOT decode, so the manager never emits 'ready'. We install a
 *       dimension-only Image stub that fires onload synchronously with sane dims
 *       (the NullRenderer never reads pixels — only the manager needs w/h to
 *       ready). This drops the native node-canvas dependency entirely.
 *   (3) getContext('2d') must return a 2D-context-shaped object (jsdom's canvas
 *       returns null without the native canvas package). The headless renderer
 *       never draws, but Phaser's Text/Graphics paths CALL context methods, so we
 *       return a no-op context that answers every method they touch.
 *   (4) Graphics.generateTexture() crashes under the NullRenderer (no
 *       blendModes); the engine calls it on every boot (ensurePlaceholderTexture
 *       / createBulletTextures). We replace it with a key-registering no-op via
 *       the real TextureManager.createCanvas (see patchGenerateTexture, applied
 *       inside the boot entry where Phaser is in scope).
 *   (5) deterministic stepping — see bootHeadlessGame.mjs (loop.stop + manual
 *       loop.step); not a DOM concern, listed here for the complete inventory.
 *
 * PURE JSDOM, NO node-canvas: verified — pure-jsdom reaches __GAME__.ready,
 * steps deterministically, and a real component fires on the real bus, ~9x
 * faster boot than node-canvas (no native module load). If a future Phaser needs
 * real pixels (it should not under HEADLESS), this is the one file to revisit.
 *
 * DEP RESOLUTION: jsdom lives in templates/core/node_modules (the run cwd's
 * package — it has phaser + esbuild too). Node ESM resolves a bare specifier
 * from the IMPORTING file's dir, and this testkit sits in the sibling
 * core-contract tree, so we resolve jsdom against core via createRequire and
 * import the absolute path. The deps deliberately land in ONE place (core).
 */
import { createRequire } from 'node:module';
import { resolve as pathResolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// repo root = templates/core-contract/src/testkit → up 4
const repoRoot = pathResolve(here, '..', '..', '..', '..');
const coreRequire = createRequire(
  pathToFileURL(pathResolve(repoRoot, 'templates/core/package.json')).href,
);
const { JSDOM } = await import(
  pathToFileURL(coreRequire.resolve('jsdom')).href
);

/**
 * PATCH (1) — land jsdom's window globals onto globalThis.
 * Phaser reads bare globals (document, navigator, HTMLCanvasElement, Image, …).
 * Node 24 exposes some window props as getter-only, so a plain assignment throws;
 * we mirror each missing key with a configurable getter, then hard-bind the few
 * Phaser dereferences directly (navigator/window/document).
 */
export function installWindowGlobals(window) {
  for (const key of Object.getOwnPropertyNames(window)) {
    if (key in globalThis) continue;
    try {
      Object.defineProperty(globalThis, key, {
        get() {
          return window[key];
        },
        configurable: true,
      });
    } catch {
      /* a non-configurable global stays as-is */
    }
  }
  for (const key of ['navigator', 'window', 'document']) {
    try {
      Object.defineProperty(globalThis, key, {
        value: window[key],
        configurable: true,
        writable: true,
      });
    } catch {
      /* ignore */
    }
  }
  globalThis.window = window;
}

/**
 * PATCH (2) — a dimension-only Image stub (drops node-canvas).
 * Phaser's TextureManager.boot() sets `img.src = <base64>` and waits for onload,
 * then reads naturalWidth/Height. jsdom's Image never fires onload for a data URI
 * (no decoder), so the manager hangs at 'booting'. This stub fires onload on the
 * next microtask with 1x1 dims — enough for the manager to ready. The headless
 * NullRenderer never samples the pixels, so the (absent) image data is never read.
 */
class HeadlessImage {
  constructor() {
    this._src = '';
    this.width = this.naturalWidth = 1;
    this.height = this.naturalHeight = 1;
    this.complete = false;
    this.onload = null;
    this.onerror = null;
  }
  set src(v) {
    this._src = v;
    this.complete = true;
    queueMicrotask(() => {
      this.naturalWidth = this.width = 1;
      this.naturalHeight = this.height = 1;
      if (typeof this.onload === 'function') this.onload();
    });
  }
  get src() {
    return this._src;
  }
  addEventListener(type, cb) {
    if (type === 'load') this.onload = cb;
    if (type === 'error') this.onerror = cb;
  }
  removeEventListener() {}
}

/**
 * PATCH (3) — a no-op 2D rendering context (drops node-canvas).
 * jsdom's HTMLCanvasElement.getContext returns null without the native canvas
 * package. The NullRenderer never draws, but Phaser's Text/Graphics object code
 * still calls context methods during create() (measureText, strokeText, …). We
 * return a context object answering every method the engine touches with a no-op
 * (text measures to width 0 — fine, headless never lays out visible glyphs).
 */
function makeNullContext(canvas) {
  return {
    canvas,
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    imageSmoothingEnabled: false,
    textAlign: 'left',
    textBaseline: 'alphabetic',
    _font: '10px sans-serif',
    get font() {
      return this._font;
    },
    set font(v) {
      this._font = v;
    },
    save() {},
    restore() {},
    translate() {},
    rotate() {},
    scale() {},
    transform() {},
    setTransform() {},
    resetTransform() {},
    clearRect() {},
    fillRect() {},
    strokeRect() {},
    beginPath() {},
    closePath() {},
    rect() {},
    roundRect() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    ellipse() {},
    quadraticCurveTo() {},
    bezierCurveTo() {},
    fill() {},
    stroke() {},
    clip() {},
    setLineDash() {},
    measureText() {
      return {
        width: 0,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: 0,
        actualBoundingBoxAscent: 0,
        actualBoundingBoxDescent: 0,
      };
    },
    fillText() {},
    strokeText() {},
    drawImage() {},
    createLinearGradient() {
      return { addColorStop() {} };
    },
    createRadialGradient() {
      return { addColorStop() {} };
    },
    createPattern() {
      return null;
    },
    getImageData(_x, _y, w, h) {
      const cw = Math.max(1, w || canvas.width || 1);
      const ch = Math.max(1, h || canvas.height || 1);
      return { data: new Uint8ClampedArray(4 * cw * ch), width: cw, height: ch };
    },
    putImageData() {},
    createImageData(w, h) {
      const cw = Math.max(1, w || 1);
      const ch = Math.max(1, h || 1);
      return { data: new Uint8ClampedArray(4 * cw * ch), width: cw, height: ch };
    },
  };
}

/**
 * Install patches (2) + (3): the headless Image + the null 2D context, plus the
 * CanvasRenderingContext2D presence flag Phaser's Features check reads
 * (`!!window.CanvasRenderingContext2D`).
 */
export function installCanvasShims(window) {
  Object.defineProperty(globalThis, 'Image', {
    value: HeadlessImage,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(window, 'Image', {
    value: HeadlessImage,
    configurable: true,
    writable: true,
  });

  // Phaser Features.canvas === !!window.CanvasRenderingContext2D — define it so
  // Phaser knows a canvas context is "available" (jsdom omits it without native
  // canvas). A bare marker class is enough; instanceof is never checked headless.
  class NullCanvasRenderingContext2D {}
  globalThis.CanvasRenderingContext2D = NullCanvasRenderingContext2D;
  try {
    Object.defineProperty(window, 'CanvasRenderingContext2D', {
      value: NullCanvasRenderingContext2D,
      configurable: true,
    });
  } catch {
    /* ignore */
  }

  // Return the null 2D context (cached per element). Non-2d contexts → null
  // (HEADLESS uses no WebGL). The canvas element stays a real jsdom Node so
  // appendChild('game-container') works.
  window.HTMLCanvasElement.prototype.getContext = function getContext(type) {
    if (type === '2d') {
      if (!this.__nullCtx) this.__nullCtx = makeNullContext(this);
      return this.__nullCtx;
    }
    return null;
  };
}

/**
 * Build the jsdom environment and install patches (1)-(3). Returns the window.
 * Patch (4) (generateTexture) needs Phaser in scope, so it is applied inside the
 * boot entry; patch (5) (deterministic stepping) is driven by the harness.
 */
export function setupHeadlessDom() {
  const dom = new JSDOM(
    '<!DOCTYPE html><html><body><div id="game-container"></div></body></html>',
    { pretendToBeVisual: true, url: 'http://localhost/' },
  );
  const { window } = dom;
  installWindowGlobals(window);
  installCanvasShims(window);
  return window;
}
