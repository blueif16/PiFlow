/**
 * ToolStackBar — the compact SUMMARY at the top of the HUD `tools` region.
 *
 * One horizontal stacked bar (segment width ∝ count) + a legend row. NOT a pie/donut:
 * with ~8 tool types a stacked bar encodes total + proportion and reads at small size.
 * Each segment is colored by the shared TOOL_TONE map (read/grep/submit_result→accent,
 * edit/write→success, bash→warn, ls/find→muted). The expanded per-tool `.ds-bars` list
 * stays below this in the tools detail (see NodeHud `Detail`).
 *
 * Segments + legend are sorted descending by count. Empty breakdown renders nothing.
 */
import { toolTone, ToolGlyph } from "./toolMeta";

export interface ToolStackBarProps {
  breakdown: Record<string, number>;
}

export function ToolStackBar({ breakdown }: ToolStackBarProps) {
  const segs = Object.entries(breakdown).sort((a, b) => b[1] - a[1]);
  const total = segs.reduce((sum, [, c]) => sum + c, 0);
  if (segs.length === 0 || total === 0) return null;

  return (
    <div className="ds-toolstack-wrap">
      <div className="ds-toolstack" role="img" aria-label="Tool-call distribution">
        {segs.map(([t, c]) => {
          const pct = Math.round((c / total) * 100);
          return (
            <span
              key={t}
              className="ds-toolstack__seg"
              data-tone={toolTone(t)}
              style={{ width: `${(c / total) * 100}%` }}
              title={`${t} · ${c} (${pct}%)`}
            />
          );
        })}
      </div>
      <div className="ds-toolstack-legend">
        {segs.map(([t, c]) => (
          <span key={t} className="ds-toolstack-legend__item" data-tone={toolTone(t)}>
            <ToolGlyph name={t} size={11} />
            {t} {c}
          </span>
        ))}
      </div>
    </div>
  );
}
