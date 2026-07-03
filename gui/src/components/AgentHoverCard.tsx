/**
 * AgentHoverCard — the UNIFIED agent identity surface, inherent to the agent class.
 *
 * Every agent node in the GUI renders through the same class (WorkflowNode); this card is that class's
 * built-in hover behavior. It shows what DEFINES the agent — the role prompt it inherited from its base,
 * the tools it may call, the skill it loads, and what it carries (model · tier · executor) — NOT a
 * repetition of the name/icon branding the node card already shows (a slim base-id line is the only
 * identity anchor). A node that adopts a base agent (`agentType`) shows the base's role prompt; a bespoke
 * node shows its own recorded loadout with "no base". Nothing here is computed: every value is an honest
 * projection of the run-view node (`data.rv`, the recorded config) + the agent catalog entry
 * (`data.agentPreset`) that toFlowGraph resolved through the observation plane.
 *
 * Visibility is CSS-only (glass.css `.ds-node:hover .ds-agentcard`) — no state, no listeners.
 */
import { AgentAvatar, type FlowNodeData } from "./WorkflowNode";

/** `{{WORKSPACE}}/packages/skills/harden-blueprint/SKILL.md` → `harden-blueprint` (display; full in title). */
function skillName(p: string): string {
  const parts = p.replace(/\/SKILL\.md$/i, "").split("/");
  return parts[parts.length - 1] || p;
}

function Row({ k, v, title, mono }: { k: string; v: string; title?: string; mono?: boolean }) {
  return (
    <div className="ds-agentcard__row">
      <span className="ds-agentcard__key">{k}</span>
      <span className={`ds-agentcard__val${mono ? " ds-agentcard__val--mono" : ""}`} title={title}>{v}</span>
    </div>
  );
}

export function AgentHoverCard({ data }: { data: FlowNodeData }) {
  const rv = data.rv;
  const preset = data.agentPreset;
  const base = data.agentType;
  // the node's RECORDED loadout first (what it actually ran with), the preset's declaration as fallback
  const tools = rv?.config?.tools ?? preset?.tools;
  const skill = rv?.config?.skill;
  const presetSkills = preset?.skills ?? [];
  const model = rv?.model ?? rv?.config?.model ?? preset?.model ?? null;
  const tier = rv?.config?.tier ?? preset?.tier;
  const executor = rv?.executor ?? "pi";
  const prompt = preset?.prompt;
  const carries = [model, tier && `tier ${tier}`, executor].filter(Boolean).join(" · ");

  return (
    <div className="ds-agentcard" role="tooltip" aria-label={`agent definition: ${data.title}`}>
      {/* slim identity anchor — NOT a branding repeat; just which base this agent is built on */}
      <div className="ds-agentcard__head">
        <span className="ds-agentcard__face" style={data.agentColor ? { color: data.agentColor } : undefined}>
          <AgentAvatar agentType={base} icon={data.agentIcon} />
        </span>
        <span className="ds-agentcard__base">{base ? `base agent · ${base}` : "bespoke · no base"}</span>
      </div>

      {/* the defining prompt — the base's ROLE prompt the node's task is appended below */}
      {prompt && (
        <div className="ds-agentcard__prompt">
          <span className="ds-agentcard__key">role prompt</span>
          <pre className="ds-agentcard__prompttext">{prompt}</pre>
        </div>
      )}

      {/* the loadout — what this agent may call and what it loads; what it ran as */}
      <div className="ds-agentcard__rows">
        {tools?.allow?.length ? <Row k="tools" v={tools.allow.join(" · ")} mono /> : null}
        {tools?.deny?.length ? <Row k="deny" v={tools.deny.join(" · ")} mono /> : null}
        {skill ? <Row k="skill" v={skillName(skill)} title={skill} mono /> : null}
        {!skill && presetSkills.length ? <Row k="skills" v={presetSkills.join(" · ")} mono /> : null}
        {carries && <Row k="carries" v={carries} mono />}
      </div>
    </div>
  );
}
