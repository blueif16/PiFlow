/**
 * EndpointSwitcher — the GLOBAL running-location indicator + one-click local⇄cloud toggle. A small angular
 * glass chip pinned top-CENTER of the viewport (a persistent reminder, clear of the top-left navigator and the
 * top-right MenuBar). Icon-ONLY at rest: a neutral MONITOR glyph = local (same-origin serve), a blue CLOUD
 * glyph = a remote control plane. The URL rides the tooltip, never as visible text (the text label the user
 * disliked is gone).
 *
 * Click opens a small ANCHORED confirmation popover (not a modal, no scrim): it names current → target and a
 * single Confirm re-points the WHOLE console via `setEndpoint` — the SAME runtime-repoint the migrate switch
 * uses (apiBase.ts). Escape or a click-away cancels. Switching local → cloud with no remote known this session
 * NEVER fabricates a URL: the popover degrades to a small URL (+ optional token) field, and Connect points there.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GlassSurface } from "./GlassSurface";
import { useEndpoint, endpointKind, planEndpointSwitch, getRememberedRemote, setEndpoint } from "../data/apiBase";
import "../styles/endpoint-switcher.css";

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

export function EndpointSwitcher() {
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

  // Resolve the toggle at render: current endpoint + the last cloud seen this session (module state, changed
  // only alongside a setEndpoint → useEndpoint re-render, so reading it here stays consistent).
  const plan = planEndpointSwitch(ep, getRememberedRemote());

  // Confirm the ready toggle — feed the resolved endpoint to the SAME repoint the migrate switch calls.
  function confirmSwitch() {
    if (plan.ready) { setEndpoint(plan.endpoint); setOpen(false); }
  }
  // Connect to a freshly-entered cloud plane (the degrade path) — never fabricated, always user-supplied.
  function connectRemote() {
    const baseUrl = url.trim();
    if (!baseUrl) { setErr("enter a control-plane URL"); return; }
    setEndpoint({ baseUrl, token: token.trim() });
    setOpen(false);
  }

  const detail = ep.baseUrl || "same-origin";

  return createPortal(
    <div className="ds-epswitch-layer" ref={layerRef}>
      <button
        type="button"
        className="ds-epswitch__btn"
        data-kind={kind}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Running on ${kind} (${detail}) — switch control plane`}
        title={`Running on ${kind} · ${detail} — click to switch`}
        onClick={() => setOpen((o) => !o)}
      >
        <Glyph kind={kind} />
      </button>

      {open && (
        <GlassSurface as="div" variant="window" legibleText role="dialog" aria-label="Switch control plane" className="ds-epswitch__pop">
          {plan.ready ? (
            <>
              <div className="ds-epswitch__head">
                <span className="ds-epswitch__state" data-kind={plan.from} data-current="true">
                  <Glyph kind={plan.from} size={14} /> {plan.from}
                </span>
                <span className="ds-epswitch__arrow" aria-hidden="true">→</span>
                <span className="ds-epswitch__state" data-kind={plan.to}>
                  <Glyph kind={plan.to} size={14} /> {plan.to}
                </span>
              </div>
              <p className="ds-epswitch__note">
                {plan.to === "local"
                  ? "Point the console at your local serve (same-origin)."
                  : <>Point the console at <span className="ds-epswitch__url">{plan.endpoint.baseUrl}</span>.</>}
              </p>
              <div className="ds-epswitch__foot">
                <button type="button" className="ds-epswitch__btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
                <button type="button" className="ds-epswitch__btn-go" onClick={confirmSwitch}>Switch to {plan.to}</button>
              </div>
            </>
          ) : (
            <>
              <div className="ds-epswitch__head">
                <span className="ds-epswitch__state" data-kind="cloud"><CloudGlyph size={14} /> connect a cloud plane</span>
              </div>
              <p className="ds-epswitch__note">No cloud control plane is known yet — enter one to point the console at it.</p>
              <label className="ds-epswitch__field">
                <span className="ds-epswitch__label">Control-plane URL</span>
                <input
                  className="ds-epswitch__input"
                  value={url}
                  onChange={(e) => { setUrl(e.target.value); setErr(null); }}
                  onKeyDown={(e) => { if (e.key === "Enter") connectRemote(); }}
                  placeholder="https://…"
                  autoFocus
                  spellCheck={false}
                  aria-label="Control-plane URL"
                />
              </label>
              <label className="ds-epswitch__field">
                <span className="ds-epswitch__label">Bearer token (optional)</span>
                <input
                  className="ds-epswitch__input"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") connectRemote(); }}
                  placeholder="for a gated serve"
                  spellCheck={false}
                  aria-label="Bearer token"
                />
              </label>
              {err && <div className="ds-epswitch__error" role="alert">{err}</div>}
              <div className="ds-epswitch__foot">
                <button type="button" className="ds-epswitch__btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
                <button type="button" className="ds-epswitch__btn-go" onClick={connectRemote} disabled={!url.trim()}>Connect</button>
              </div>
            </>
          )}
        </GlassSurface>
      )}
    </div>,
    document.body,
  );
}
