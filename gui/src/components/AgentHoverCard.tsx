/**
 * AgentHoverCard — the UNIFIED agent identity surface, inherent to the agent class.
 *
 * Every agent node renders through the same class (WorkflowNode); this card is that class's built-in
 * hover behavior: the agent's DEFINITION at a glance — the SKILL it loads and the ROLE PROMPT first
 * (they define the agent), the TOOLS as short tag chips, and the READ/WRITE SCOPE it operates under.
 * Never a repeat of the name/icon branding (a slim base-id line is the only identity anchor).
 *
 * The skill chip is a real button: clicking it ENTERS the node's detail view (the same expand(id) the
 * card click performs) where the full definition lives. Every value is an honest projection of the
 * recorded run-view node (`data.rv.config` — tools/skill/sandbox as the node actually ran) + the agent
 * catalog entry (`data.agentPreset`) resolved through the observation plane. Visibility is CSS-only
 * (glass.css `.ds-node:hover .ds-agentcard`).
 */
import { useSkill } from "./SkillContext";
import { AgentAvatar, type FlowNodeData } from "./WorkflowNode";

/** `{{WORKSPACE}}/packages/skills/harden-blueprint/SKILL.md` → `harden-blueprint` (display; full in title). */
function skillName(p: string): string {
  const parts = p.replace(/\/SKILL\.md$/i, "").split("/");
  return parts[parts.length - 1] || p;
}

/** Shorten a scope path for a tag: keep tokens (`{{RUN}}`) and globs as-is, else the last 2 segments. */
function scopeTag(p: string): string {
  if (p.startsWith("{{")) return p;
  const parts = p.split("/").filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join("/") : p;
}

/** A tiny book glyph for the skill chip (inline, no icon dependency — the KindIcon pattern). */
function SkillGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 3.5A1.5 1.5 0 014.5 2H13v11H4.5A1.5 1.5 0 003 14.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M3 13.5A1.5 1.5 0 014.5 12H13" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

function TagRow({ k, tags, title }: { k: string; tags: string[]; title?: (t: string) => string | undefined }) {
  if (!tags.length) return null;
  return (
    <div className="ds-agentcard__row">
      <span className="ds-agentcard__key">{k}</span>
      <span className="ds-agentcard__tags">
        {tags.map((t) => (
          <span key={t} className="ds-agentcard__tag" title={title?.(t)}>{t}</span>
        ))}
      </span>
    </div>
  );
}

export function AgentHoverCard({ data }: { data: FlowNodeData }) {
  const { openSkill } = useSkill();
  const rv = data.rv;
  const preset = data.agentPreset;
  const base = data.agentType;
  // the node's RECORDED loadout first (what it actually ran with), the preset's declaration as fallback
  const skill = rv?.config?.skill;
  const skills = skill ? [skill] : (preset?.skills ?? []);
  const tools = rv?.config?.tools ?? preset?.tools;
  const readScope = rv?.config?.sandbox?.readScope ?? [];
  const owns = rv?.config?.sandbox?.owns ?? [];
  const prompt = preset?.prompt;
  const carries = [rv?.model ?? rv?.config?.model ?? preset?.model, rv?.config?.tier ?? preset?.tier, rv?.executor ?? "pi"]
    .filter(Boolean).join(" · ");

  return (
    <div className="ds-agentcard" role="tooltip" aria-label={`agent definition: ${data.title}`}>
      {/* slim identity anchor — which base this agent is built on; never a branding repeat */}
      <div className="ds-agentcard__head">
        <span className="ds-agentcard__face" style={data.agentColor ? { color: data.agentColor } : undefined}>
          <AgentAvatar agentType={base} icon={data.agentIcon} />
        </span>
        <span className="ds-agentcard__base">{base ? `base agent · ${base}` : "bespoke · no base"}</span>
      </div>

      {/* THE DEFINITION — skill first (a real button: click → the left skill-bundle panel), then the role prompt */}
      {skills.length > 0 && (
        <div className="ds-agentcard__row">
          <span className="ds-agentcard__key">skill</span>
          <span className="ds-agentcard__tags">
            {skills.map((s) => (
              <button
                key={s}
                type="button"
                className="ds-agentcard__tag ds-agentcard__tag--skill"
                title={`${s} — open skill bundle`}
                onClick={(e) => { e.stopPropagation(); openSkill(s); }}
              >
                <SkillGlyph />
                {skillName(s)}
              </button>
            ))}
          </span>
        </div>
      )}

      {prompt && (
        <div className="ds-agentcard__prompt">
          <span className="ds-agentcard__key">role prompt</span>
          <pre className="ds-agentcard__prompttext">{prompt}</pre>
        </div>
      )}

      {/* the world it operates in: tools as tags + the read/write scope */}
      <div className="ds-agentcard__rows">
        <TagRow k="tools" tags={tools?.allow ?? []} />
        <TagRow k="deny" tags={tools?.deny ?? []} />
        <TagRow k="reads" tags={readScope.map(scopeTag)} title={(t) => readScope.find((p) => scopeTag(p) === t)} />
        <TagRow k="owns" tags={owns} />
        {carries && (
          <div className="ds-agentcard__row">
            <span className="ds-agentcard__key">carries</span>
            <span className="ds-agentcard__val ds-agentcard__val--mono">{carries}</span>
          </div>
        )}
      </div>
    </div>
  );
}
