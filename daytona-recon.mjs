// One-page recon driver — drives headless Chromium against a live URL and reports
// what animation/SVG detail is actually recoverable. NOT the full harvest harness.
// Run: NODE_PATH=<global pw node_modules> node daytona-recon.mjs <url> <outdir>
import pw from '/Users/tk/.nvm/versions/node/v24.1.0/lib/node_modules/rednote-mcp/node_modules/playwright/index.js';
const { chromium } = pw;
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const URL = process.argv[2] || 'https://www.daytona.io/';
const OUT = process.argv[3] || 'harvest/daytona.io/home';
const BODIES = join(OUT, 'bodies');
mkdirSync(BODIES, { recursive: true });

const ANIM_RE = /\.(json|lottie|riv)(\?|$)/i;
const LIB_RE  = /(lottie|bodymovin|framer-motion|framerusercontent|gsap|rive|animation)/i;

const captured = [];   // animation-source responses
const allResp  = [];   // every response (url + ct) for the fingerprint
let bodyN = 0;

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1600 } });

page.on('response', async (resp) => {
  const url = resp.url();
  const ct  = (resp.headers()['content-type'] || '').split(';')[0];
  allResp.push({ url, ct });
  const isAnim = ANIM_RE.test(url) ||
    ((ct.includes('json') || ct.includes('octet-stream')) && LIB_RE.test(url));
  if (!isAnim) return;
  let savedAs = null, bytes = null;
  try {
    const buf = await resp.body();
    bytes = buf.length;
    if (bytes < 4_000_000) {                       // save bodies up to 4 MB
      savedAs = `anim_${String(++bodyN).padStart(2, '0')}_${url.split('/').pop().split('?')[0].slice(0, 40)}`;
      writeFileSync(join(BODIES, savedAs), buf);
    }
  } catch { /* body may be unavailable */ }
  captured.push({ url, ct, status: resp.status(), bytes, savedAs });
});

console.error(`→ navigating ${URL}`);
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
try { await page.waitForLoadState('networkidle', { timeout: 30_000 }); } catch {}
await page.waitForTimeout(3500);                   // let Lottie/Framer settle
// nudge lazy content
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await page.waitForTimeout(2500);
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(1000);

const dom = await page.evaluate(() => {
  const svgs = [...document.querySelectorAll('svg')].map((s) => ({
    viewBox: s.getAttribute('viewBox'),
    w: s.getAttribute('width'), h: s.getAttribute('height'),
    cls: s.getAttribute('class'),
    isLottie: /__lottie_element/.test(s.innerHTML),
    htmlLen: s.outerHTML.length,
  }));
  const framerNames = {};
  document.querySelectorAll('[data-framer-name]').forEach((e) => {
    const n = e.getAttribute('data-framer-name');
    framerNames[n] = (framerNames[n] || 0) + 1;
  });
  // @keyframes + animation usage from same-origin sheets (cross-origin throws → skip)
  const keyframes = new Set(); let sheetsBlocked = 0;
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules; } catch { sheetsBlocked++; continue; }
    for (const r of rules || []) {
      if (r.type === CSSRule.KEYFRAMES_RULE) keyframes.add(r.cssText);
    }
  }
  const scripts = [...document.querySelectorAll('script[src]')].map((s) => s.src);
  return {
    title: document.title,
    svgCount: svgs.length,
    lottieSvgCount: svgs.filter((s) => s.isLottie).length,
    svgs: svgs.slice(0, 40),
    framerNames,
    framerNameCount: Object.keys(framerNames).length,
    keyframes: [...keyframes],
    sheetsBlocked,
    libs: {
      lottie: typeof window.lottie !== 'undefined' || typeof window.bodymovin !== 'undefined',
      gsap: typeof window.gsap !== 'undefined',
      framer: !!document.querySelector('[data-framer-name],[data-framer-component-type]'),
      lottiePlayers: document.querySelectorAll('lottie-player, dotlottie-player').length,
    },
    scripts: scripts.slice(0, 60),
  };
});

// save full inline svg outerHTML for reference
const svgHtml = await page.evaluate(() =>
  [...document.querySelectorAll('svg')].map((s) => s.outerHTML));
writeFileSync(join(OUT, 'inline-svgs.html'), svgHtml.join('\n\n<!-- ===== -->\n\n'));
writeFileSync(join(OUT, 'keyframes.css'), dom.keyframes.join('\n\n'));

const report = { url: URL, capturedAnim: captured, dom,
  animSourceCount: captured.length,
  imageAssets: allResp.filter((r) => /framerusercontent|\.(svg|png|webp)(\?|$)/i.test(r.url))
    .map((r) => r.url).slice(0, 60) };
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));

console.error(`✓ done. anim sources captured: ${captured.length}, inline svgs: ${dom.svgCount} (lottie: ${dom.lottieSvgCount})`);
console.log(JSON.stringify({
  title: dom.title,
  animSources: captured.map((c) => ({ url: c.url, ct: c.ct, bytes: c.bytes, savedAs: c.savedAs })),
  svgCount: dom.svgCount, lottieSvgCount: dom.lottieSvgCount,
  svgSummary: dom.svgs.map((s) => ({ viewBox: s.viewBox, w: s.w, h: s.h, lottie: s.isLottie })),
  framerNameCount: dom.framerNameCount,
  topFramerNames: Object.entries(dom.framerNames).sort((a,b)=>b[1]-a[1]).slice(0,25),
  keyframesCount: dom.keyframes.length, sheetsBlocked: dom.sheetsBlocked,
  libs: dom.libs,
}, null, 2));

await browser.close();
