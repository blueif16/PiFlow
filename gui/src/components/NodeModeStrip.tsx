/**
 * NodeModeStrip — the compact info strip a view-mode paints beneath each node on
 * the map. Absolutely positioned just below the card (out of flow, pointer-events
 * off) so it never shifts the node box or the edge anchor points, and clicks fall
 * straight through to the canvas.
 *
 * Every value is real, read from the node's distilled run-view payload (data.rv).
 * A LIVE/foreign run carries a lean model (status only, no rv) — those modes
 * degrade to a muted "—" rather than fabricate. See the per-mode branches below.
 */
import { AgentPresetIcon, type FlowNodeData } from "./WorkflowNode";
import type { ViewMode } from "./ViewModeContext";
import { contextTone, timeTone, DEFAULT_CONTEXT_WINDOW, formatBytes, formatMs, formatTokens, type ContextTone } from "../data/runView";
import "../styles/modes.css";

const fileName = (p: string) => p.split("/").pop() || p;

/** one labelled mini progress bar (tag · track · value) for the Status mode */
function MiniBar({ tag, tone, frac, value }: { tag: string; tone: ContextTone; frac: number; value: string }) {
  return (
    <div className="ds-minibar">
      <span className="ds-minibar__tag">{tag}</span>
      <span className="ds-minibar__track" data-tone={tone}>
        <span className="ds-minibar__fill" style={{ width: `${Math.min(1, Math.max(0, frac)) * 100}%` }} />
      </span>
      <span className="ds-minibar__val" data-tone={tone}>{value}</span>
    </div>
  );
}

export function NodeModeStrip({ mode, data }: { mode: ViewMode; data: FlowNodeData }) {
  const rv = data.rv;

  if (mode === "status") {
    // the two most important health signals, as two progress bars:
    //   time = this run's duration vs the average of prior runs
    //   ctx  = peak context vs the model's window
    // A RUNNING node has no final durationMs yet — show elapsed-so-far (now − startedAt) so the time bar
    // fills (and flags warn/high once it overshoots the average) instead of reading "—" / "no run data".
    const running = data.status === "running";
    const d = rv?.derived;
    const dur = rv?.durationMs ?? (running && rv?.startedAt ? Math.max(0, Date.now() - Date.parse(rv.startedAt)) : null);
    const avg = rv?.expectedMs ?? null;
    const peak = rv?.tokens?.contextPeak ?? 0;
    if (dur == null && !peak) return <div className="ds-nodemode ds-nodemode--muted">no run data</div>;

    // time: a SETTLED node carries derived.time from the observe surface (null is a VERDICT there, not a
    // gap — a reused node's durationMs is a PRIOR run's carry, a baseline-less node has nothing to compare
    // against); a RUNNING node has no final duration, so it ticks live (the clock exception) and tones via
    // the pinned mirror on live elapsed. The local recompute exists ONLY for that running case — never
    // re-tone a settled node the observe surface declined to tone.
    const ratio = d?.time ? d.time.ratio : running && dur != null && avg && avg > 0 ? dur / avg : null;
    const timeFrac = ratio != null ? ratio : dur != null ? 1 : 0;
    const timeToneV: ContextTone = d?.time?.tone ?? (ratio != null ? timeTone(ratio) : "ok");
    const timeVal = dur != null ? (avg ? `${formatMs(dur)} / ${formatMs(avg)}` : formatMs(dur)) : "—";

    // context pressure: derived once in the observe surface (present on live nodes too via ensureDerived).
    const win = rv?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    const ctxFrac = d?.context.frac ?? (peak ? peak / win : 0);
    const ctxToneV = d?.context.tone ?? contextTone(ctxFrac);
    const ctxVal = peak ? `${formatTokens(peak)} / ${formatTokens(win)}` : "—";

    return (
      <div className="ds-nodemode ds-nodemode--status">
        <MiniBar tag="time" tone={timeToneV} frac={timeFrac} value={timeVal} />
        <MiniBar tag="ctx" tone={ctxToneV} frac={ctxFrac} value={ctxVal} />
        {(rv?.truncated || (rv?.retries ?? 0) > 0) && (
          <div className="ds-nodemode__badges">
            {rv?.truncated && <span className="ds-nodebadge" data-tone="high" title="Output hit max_tokens — truncated">TRUNC</span>}
            {(rv?.retries ?? 0) > 0 && <span className="ds-nodebadge" data-tone="warn" title="Provider retries (429/overload)">↻ {rv?.retries}</span>}
          </div>
        )}
      </div>
    );
  }

  if (mode === "model") {
    if (!rv?.model) return <div className="ds-nodemode ds-nodemode--muted">no model data</div>;
    const sub = [rv.provider, rv.api].filter(Boolean).join(" · ");
    return (
      <div className="ds-nodemode ds-nodemode--model">
        <span className="ds-modelchip">{rv.model}</span>
        {sub && <span className="ds-nodemode__sub">{sub}</span>}
      </div>
    );
  }

  if (mode === "basis") {
    // (expert-representations) The BASE AGENT this node is built on — its `agentType` preset, one of the ~6
    // base "postures" (Scout/Architect/Maker/Critic/Listener/Scribe). `mergePreset` folded the base's role-
    // prompt + base tools into the node at author-time; the label/icon/color ride through (spec → observe →
    // here), resolved from the agents catalog. A node with no `agentType` is bespoke — authored from scratch.
    // The face is a CIRCULAR avatar: today a placeholder glyph (AgentPresetIcon keyed by display.icon); the
    // per-base human-face SVGs swap in by that same key (purely cosmetic — never affects status/layout).
    const base = rv?.agentType;
    if (!base) return <div className="ds-nodemode ds-nodemode--muted">bespoke · no base</div>;
    return (
      <div className="ds-nodemode ds-nodemode--basis">
        <span className="ds-basiscard" title={`base agent: ${base}`}>
          <span className="ds-basiscard__face" style={data.agentColor ? { color: data.agentColor } : undefined}>
            <AgentPresetIcon icon={data.agentIcon} />
          </span>
          <span className="ds-basiscard__text">
            <span className="ds-basiscard__label">{data.agentLabel ?? base}</span>
            <span className="ds-basiscard__id">{base}</span>
          </span>
        </span>
      </div>
    );
  }

  // artifacts — everything this node produced (artifacts ∪ writes), unified ONCE in the observe surface.
  const files = rv?.derived?.outputs ?? [];
  if (files.length === 0) return <div className="ds-nodemode ds-nodemode--muted">no outputs</div>;
  const shown = files.slice(0, 3);
  return (
    <div className="ds-nodemode ds-nodemode--artifacts">
      {shown.map((f) => (
        <div key={f.path} className="ds-artrow" data-ok={f.ok}>
          <span className="ds-artrow__name" title={f.path}>{fileName(f.path)}</span>
          <span className="ds-artrow__size">{f.bytes != null ? formatBytes(f.bytes) : ""}</span>
        </div>
      ))}
      {files.length > shown.length && (
        <div className="ds-artrow ds-artrow--more">+{files.length - shown.length} more</div>
      )}
    </div>
  );
}
