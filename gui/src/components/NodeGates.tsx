/**
 * NodeGates / NodeHooks — the LEGIBLE projection of a node's OBSERVED post-node consequence chain (its
 * run-view `config.gates`, distilled by core `summarizeGates` and carried through observe). Two surfaces,
 * one hexagon vocabulary:
 *   - <NodeGates variant="card"> → the compact always-on HEX ROW beneath the node card (the "short symbol").
 *   - <NodeHooks>                → the HUD "Hooks" section: plain-language pre / post / human lanes.
 *
 * PURE + presentational: it reads the run-view's `GateSummary` and renders it — it NEVER reads the template
 * `/__piflow/node-config` side-channel (that is the Compose EDITOR's concern). config is the single source of
 * truth; this is an honest projection of it — never an invented value. Each entry is tinted by its on-fail
 * POLICY so the posture (blocks / warns / retries / escalates) reads at a glance, and carries a distinct glyph.
 */
import type { GateSummary, GateSummaryEntry } from "../data/runView";
import { observedGateHexes, observedTone } from "../data/gates";
import { GateHex, GateKindGlyph } from "./GateGlyph";
import "../styles/gates.css";

/** A one-line human summary of the chain — the row's title/aria (screen-reader + hover legibility). */
export function gatesTip(gates: GateSummary): string {
  const parts = gates.entries.map((e) => `${e.label}${e.onFail ? ` → ${e.onFail}` : ""}`);
  return `after this node: ${parts.join("; ")}`;
}

/** The plain-language policy clause for a gate — derived ONLY from real entry fields (never invented). */
function policyClause(e: GateSummaryEntry): string {
  if (e.advisory) return "advisory";
  if (e.onFail === "block" || e.onFail === "stop") return "blocks on fail";
  if (e.onFail === "warn") return "warns on fail";
  if (e.onFail === "retry") return "retries on fail";
  if (e.onFail === "escalate") return "escalates to a stronger model on fail";
  if (e.kind === "reroute" || e.kind === "retry") return "reroutes back on fail";
  if (e.kind === "escalate") return "escalates on fail";
  if (e.kind === "notify") return "notifies";
  return "";
}

/** The compact always-on HEX row for the node card (the "short symbol"). */
function CardRow({ gates }: { gates: GateSummary }) {
  const hexes = observedGateHexes(gates);
  const tip = gatesTip(gates);
  return (
    <div className="ds-gatehexes" title={tip} aria-label={tip}>
      {hexes.map((h, i) => (
        <GateHex key={`${h.glyph}-${i}`} desc={h} size={20} />
      ))}
    </div>
  );
}

/** One plain-language hook row: a hexagon glyph + the entry's label and its policy clause. */
function HookRow({ e }: { e: GateSummaryEntry }) {
  const tone = observedTone(e);
  const clause = policyClause(e);
  return (
    <div className="ds-hook">
      <GateHex desc={{ glyph: glyphOf(e.kind), tone, label: e.label }} size={18} />
      <span className="ds-hook__text">
        <b>{e.label}</b>
        {clause && <span className="ds-hook__policy"> · {clause}</span>}
      </span>
    </div>
  );
}

/** map a GateSummary entry kind → the glyph kind (kept local to avoid re-exporting the data-layer mapper). */
function glyphOf(kind: GateSummaryEntry["kind"]): Parameters<typeof GateKindGlyph>[0]["kind"] {
  switch (kind) {
    case "exec": return "execution";
    case "judge": return "judge";
    case "human": return "human";
    case "reroute":
    case "retry": return "retry";
    case "escalate": return "escalate";
    case "notify": return "notify";
    default: return "check";
  }
}

/**
 * The HUD "Hooks" section — plain-language lanes derived from the node's OBSERVED config. Three lanes:
 *   pre   → gates that run BEFORE the node (rare today; renders "(none)" when empty)
 *   post  → each gate that runs AFTER the node (execution / agentic check / floor …), with its policy
 *   human → the HITL approval (a person approves before the output propagates), with the question
 * One honest rendering from config; nothing invented.
 */
export function NodeHooks({ gates }: { gates?: GateSummary }) {
  if (!gates || (gates.entries.length === 0 && !gates.checkpoint)) return null;
  const pre = gates.entries.filter((e) => e.when === "pre");
  const post = gates.entries.filter((e) => e.when !== "pre" && e.kind !== "human");
  const human = gates.entries.filter((e) => e.kind === "human");

  return (
    <div className="ds-hooks">
      <span className="ds-hooks__title">Hooks</span>

      <div className="ds-hook-lane">
        <span className="ds-hook-lane__tag">pre</span>
        <div className="ds-hook-lane__items">
          {pre.length === 0 ? <span className="ds-hook-lane__none">(none)</span> : pre.map((e, i) => <HookRow key={i} e={e} />)}
        </div>
      </div>

      <div className="ds-hook-lane">
        <span className="ds-hook-lane__tag">post</span>
        <div className="ds-hook-lane__items">
          {post.length === 0 ? <span className="ds-hook-lane__none">(none)</span> : post.map((e, i) => <HookRow key={i} e={e} />)}
        </div>
      </div>

      {(human.length > 0 || gates.checkpoint) && (
        <div className="ds-hook-lane">
          <span className="ds-hook-lane__tag">human</span>
          <div className="ds-hook-lane__items">
            {human.length > 0
              ? human.map((e, i) => (
                  <div key={i} className="ds-hook">
                    <GateHex desc={{ glyph: "human", tone: "human", label: e.label }} size={18} />
                    <span className="ds-hook__text"><b>approve before the output propagates</b><span className="ds-hook__policy"> · {e.label}</span></span>
                  </div>
                ))
              : (
                  <div className="ds-hook">
                    <GateHex desc={{ glyph: "human", tone: "human", label: "human checkpoint" }} size={18} />
                    <span className="ds-hook__text"><b>approve before the output propagates</b><span className="ds-hook__policy"> · {gates.checkpoint} checkpoint</span></span>
                  </div>
                )}
          </div>
        </div>
      )}
    </div>
  );
}

export function NodeGates({ gates, variant }: { gates?: GateSummary; variant: "card" | "detail" }) {
  if (!gates || gates.entries.length === 0) return null;
  return variant === "card" ? <CardRow gates={gates} /> : <NodeHooks gates={gates} />;
}
