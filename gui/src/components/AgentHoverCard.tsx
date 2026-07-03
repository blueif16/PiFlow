/**
 * AgentHoverCard — the UNIFIED agent identity surface, inherent to the agent class.
 *
 * Every agent node in the GUI renders through the same class (WorkflowNode); this card is that
 * class's built-in hover behavior: hover (or keyboard-focus) any agent and see WHO it is — its
 * base agent (face + id), the model it ran, its executor, the tools/skills it carries, and the
 * ROLE PROMPT it inherited from its base. A node that adopts a base agent (`agentType`) shows the
 * base's identity; a bespoke node shows its own run facts with "no base". Nothing here is computed:
 * every row is an honest projection of the run-view node (`data.rv`) + the agent catalog entry
 * (`data.agentPreset`) that toFlowGraph resolved through the observation plane.
 *
 * Visibility is CSS-only (glass.css `.ds-node:hover .ds-agentcard`) — no state, no listeners.
 */
import { AgentAvatar, type FlowNodeData } from "./WorkflowNode";

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="ds-agentcard__row">
      <span className="ds-agentcard__key">{k}</span>
      <span className={`ds-agentcard__val${mono ? " ds-agentcard__val--mono" : ""}`}>{v}</span>
    </div>
  );
}

export function AgentHoverCard({ data }: { data: FlowNodeData }) {
  const rv = data.rv;
  const preset = data.agentPreset;
  const base = data.agentType;
  // the node's EFFECTIVE run facts first (what it ran as), the preset's declaration as fallback
  const model = rv?.model ?? rv?.config?.model ?? preset?.model ?? null;
  const tier = rv?.config?.tier ?? preset?.tier;
  const executor = rv?.executor ?? "pi";
  const tools = rv?.config?.tools?.allow ?? preset?.tools?.allow;
  const skills = preset?.skills;
  const prompt = preset?.prompt;

  return (
    <div className="ds-agentcard" role="tooltip" aria-label={`agent details: ${data.title}`}>
      <div className="ds-agentcard__head">
        <span className="ds-agentcard__face" style={data.agentColor ? { color: data.agentColor } : undefined}>
          <AgentAvatar agentType={base} icon={data.agentIcon} />
        </span>
        <span className="ds-agentcard__who">
          <span className="ds-agentcard__label">{data.agentLabel ?? base ?? data.title}</span>
          <span className="ds-agentcard__base">{base ? `base agent · ${base}` : "bespoke · no base"}</span>
        </span>
      </div>

      <div className="ds-agentcard__rows">
        <Row k="model" v={model ?? "—"} mono />
        {tier && <Row k="tier" v={tier} mono />}
        <Row k="executor" v={executor} mono />
        {tools?.length ? <Row k="tools" v={tools.join(" · ")} /> : null}
        {skills?.length ? <Row k="skills" v={skills.join(" · ")} /> : null}
      </div>

      {prompt && (
        <div className="ds-agentcard__prompt">
          <span className="ds-agentcard__key">role prompt</span>
          <pre className="ds-agentcard__prompttext">{prompt}</pre>
        </div>
      )}
    </div>
  );
}
