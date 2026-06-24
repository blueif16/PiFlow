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
import type { FlowNodeData } from "./WorkflowNode";
import type { ViewMode } from "./ViewModeContext";
import { contextTone, DEFAULT_CONTEXT_WINDOW, formatBytes, formatMs, formatTokens, type ContextTone } from "../data/runView";
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
    const dur = rv?.durationMs ?? null;
    const avg = rv?.expectedMs ?? null;
    const peak = rv?.tokens?.contextPeak ?? 0;
    if (dur == null && !peak) return <div className="ds-nodemode ds-nodemode--muted">no run data</div>;

    const ratio = dur != null && avg && avg > 0 ? dur / avg : null;
    const timeFrac = ratio != null ? ratio : dur != null ? 1 : 0;
    const timeTone: ContextTone = ratio == null ? "ok" : ratio > 1.5 ? "high" : ratio > 1 ? "warn" : "ok";
    const timeVal = dur != null ? (avg ? `${formatMs(dur)} / ${formatMs(avg)}` : formatMs(dur)) : "—";

    const win = rv?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    const ctxFrac = peak ? peak / win : 0;
    const ctxToneV = contextTone(ctxFrac);
    const ctxVal = peak ? `${formatTokens(peak)} / ${formatTokens(win)}` : "—";

    return (
      <div className="ds-nodemode ds-nodemode--status">
        <MiniBar tag="time" tone={timeTone} frac={timeFrac} value={timeVal} />
        <MiniBar tag="ctx" tone={ctxToneV} frac={ctxFrac} value={ctxVal} />
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

  // artifacts — everything this node produced (artifacts ∪ writes), name + size
  const arts = rv?.artifacts ?? [];
  const extraWrites = (rv?.writes ?? []).filter((w) => !arts.some((a) => a.displayPath === w.displayPath));
  const files = [
    ...arts.map((a) => ({ path: a.displayPath, bytes: a.bytes, ok: a.exists })),
    ...extraWrites.map((w) => ({ path: w.displayPath, bytes: w.bytes, ok: w.verified })),
  ];
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
