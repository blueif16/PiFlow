/**
 * ControlPlaneChip — the CONSOLIDATED control-plane control, pinned TOP-CENTER on the top edge. ONE
 * angular glass chip that merges the two remote actions into a single anchored popover:
 *   - SWITCH the whole console local ⇄ cloud (one-click, when a remote is known this session), and
 *   - CONNECT a fresh remote control plane (the degrade path: a URL + optional bearer).
 *
 * At rest it is icon-only: a MONITOR glyph = local (same-origin serve), a CLOUD glyph = a remote control
 * plane — PLUS a small connection DOT before the glyph that colours the plane's liveness (green = reachable,
 * red = unreachable, amber = connecting). The URL rides the tooltip, never as a visible label.
 *
 * Click opens the popover BELOW the chip (no scrim): current → target with a single Confirm that re-points
 * the WHOLE console via `setEndpoint` (the SAME runtime repoint the migrate switch uses). Escape / click-away
 * cancels. Local → cloud with no remote known this session degrades to a URL (+ token) field.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GlassSurface } from "./GlassSurface";
import { useEndpoint, endpointKind, planEndpointSwitch, getRememberedRemote, setEndpoint } from "../data/apiBase";
import "../styles/control-plane-chip.css";

/** liveness of the control plane the console is pointed at (from the canvas index poll). */
export type ControlHealth = "ok" | "error" | "connecting";

/** local = this machine's serve. A monitor outline (calm, neutral). */
function MonitorGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="2.75" width="12" height="8.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6 13.75h4M8 11.25v2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/** cloud = a remote control plane. A cloud outline (the loud, blue-accented state). */
function CloudGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M11.4 12.5H4.7A2.7 2.7 0 0 1 4.35 7.1 3.5 3.5 0 0 1 11.1 6.65 2.75 2.75 0 0 1 11.4 12.5Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const Glyph = ({ kind, size }: { kind: "local" | "cloud"; size?: number }) =>
  kind === "cloud" ? <CloudGlyph size={size} /> : <MonitorGlyph size={size} />;

export function ControlPlaneChip({ health = "connecting" }: { health?: ControlHealth }) {
  const ep = useEndpoint();
  const kind = endpointKind(ep.baseUrl);
  const [open, setOpen] = useState(false);
  // the local→cloud degrade path: a URL (+ optional bearer) the user types when no remote is known this session.
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);

  // Click-away or Escape closes — the exact convention the MenuBar switcher + every overlay obeys.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!layerRef.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown, true); document.removeEventListener("keydown", onKey); };
  }, [open]);

  // Reset the inline entry each time the popover opens (a fresh remembered-remote read happens in render below).
  useEffect(() => { if (open) { setUrl(""); setToken(""); setErr(null); } }, [open]);

  // Resolve the toggle at render: current endpoint + the last cloud seen this session.
  const plan = planEndpointSwitch(ep, getRememberedRemote());

  function confirmSwitch() {
    if (plan.ready) { setEndpoint(plan.endpoint); setOpen(false); }
  }
  function connectRemote() {
    const baseUrl = url.trim();
    if (!baseUrl) { setErr("enter a control-plane URL"); return; }
    setEndpoint({ baseUrl, token: token.trim() });
    setOpen(false);
  }

  const detail = ep.baseUrl || "same-origin";
  const healthLabel = health === "ok" ? "reachable" : health === "error" ? "unreachable" : "connecting";

  return createPortal(
    <div className="ds-cpchip-layer" ref={layerRef}>
      <button
        type="button"
        className="ds-cpchip__btn"
        data-kind={kind}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Control plane: ${kind} (${detail}) — ${healthLabel}. Click to switch or connect.`}
        title={`${kind} · ${detail} · ${healthLabel} — click to switch / connect`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="ds-cpchip__dot" data-health={health} aria-hidden="true" />
        <Glyph kind={kind} />
      </button>

      {open && (
        <GlassSurface as="div" variant="window" legibleText role="dialog" aria-label="Control plane" className="ds-cpchip__pop">
          {plan.ready ? (
            <>
              <div className="ds-cpchip__head">
                <span className="ds-cpchip__state" data-kind={plan.from} data-current="true">
                  <Glyph kind={plan.from} size={14} /> {plan.from}
                </span>
                <span className="ds-cpchip__arrow" aria-hidden="true">→</span>
                <span className="ds-cpchip__state" data-kind={plan.to}>
                  <Glyph kind={plan.to} size={14} /> {plan.to}
                </span>
              </div>
              <p className="ds-cpchip__note">
                {plan.to === "local"
                  ? "Point the console at your local serve (same-origin)."
                  : <>Point the console at <span className="ds-cpchip__url">{plan.endpoint.baseUrl}</span>.</>}
              </p>
              <div className="ds-cpchip__foot">
                <button type="button" className="ds-cpchip__btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
                <button type="button" className="ds-cpchip__btn-go" onClick={confirmSwitch}>Switch to {plan.to}</button>
              </div>
            </>
          ) : (
            <>
              <div className="ds-cpchip__head">
                <span className="ds-cpchip__state" data-kind="cloud"><CloudGlyph size={14} /> connect a cloud plane</span>
              </div>
              <p className="ds-cpchip__note">No cloud control plane is known yet — enter one to point the console at it.</p>
              <label className="ds-cpchip__field">
                <span className="ds-cpchip__label">Control-plane URL</span>
                <input
                  className="ds-cpchip__input"
                  value={url}
                  onChange={(e) => { setUrl(e.target.value); setErr(null); }}
                  onKeyDown={(e) => { if (e.key === "Enter") connectRemote(); }}
                  placeholder="https://…"
                  autoFocus
                  spellCheck={false}
                  aria-label="Control-plane URL"
                />
              </label>
              <label className="ds-cpchip__field">
                <span className="ds-cpchip__label">Bearer token (optional)</span>
                <input
                  className="ds-cpchip__input"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") connectRemote(); }}
                  placeholder="for a gated serve"
                  spellCheck={false}
                  aria-label="Bearer token"
                />
              </label>
              {err && <div className="ds-cpchip__error" role="alert">{err}</div>}
              <div className="ds-cpchip__foot">
                <button type="button" className="ds-cpchip__btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
                <button type="button" className="ds-cpchip__btn-go" onClick={connectRemote} disabled={!url.trim()}>Connect</button>
              </div>
            </>
          )}
        </GlassSurface>
      )}
    </div>,
    document.body,
  );
}
