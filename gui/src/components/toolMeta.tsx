/**
 * toolMeta — the ONE place the GUI maps a pi tool name → its tone + inline glyph, and the shared
 * <ToolTag> pill (icon + label + optional count) every surface renders (the agent-definition tool row,
 * the HUD tool chips, the ToolStackBar legend). Kept in one module so tool colour + iconography never
 * drift between surfaces.
 *
 * The canonical NATIVE pi tools come from `@piflow/core` tools/registry.ts (BUILTIN_TOOLS + submit_result):
 *   read · write · edit · grep · find · ls · bash · submit_result
 * A node can also run under the claude-code executor, whose tool names are Capitalized (Read/Write/Bash/
 * Glob/Grep/Edit/MultiEdit/WebSearch/WebFetch/Task/TodoWrite) — so `resolveTool` lowercases + aliases them
 * onto the same vocabulary. An sdk/mcp tool (namespaced `ns:name` / `ns__name` / `ns.name`) falls back to a
 * neutral plug glyph; anything unknown gets the generic tag glyph. The icon is purely cosmetic — an unknown
 * name never breaks a chip.
 */

import type { ReactNode, MouseEvent as ReactMouseEvent } from "react";

/** tool → accent class: read/search=accent, write/edit=success, exec=warn, else muted. Mirrors the
 *  telemetry research's by-family palette (read=cool, write=amber, exec=hot). */
export const TOOL_TONE: Record<string, string> = {
  read: "accent", grep: "accent", glob: "accent", find: "muted", ls: "muted",
  edit: "success", multiedit: "success", write: "success",
  bash: "warn",
  submit_result: "accent", web_search: "muted", web_fetch: "muted", task: "accent", todo: "muted",
};

/** Canonical tool key for a raw name: lowercase, and alias the claude-code / mcp spellings onto the pi
 *  vocabulary so both executors colour + icon identically. Returns a key into TOOL_TONE / TOOL_GLYPH. */
export function resolveTool(raw: string): string {
  const n = raw.toLowerCase();
  const alias: Record<string, string> = {
    multiedit: "edit", glob: "grep", searchreplace: "edit",
    websearch: "web_search", webfetch: "web_fetch", todowrite: "todo", notebookedit: "edit",
  };
  return alias[n] ?? n;
}

export const toolTone = (t: string) => TOOL_TONE[resolveTool(t)] ?? "muted";

/** True when a name is an sdk/mcp tool (namespaced) rather than a bare native tool. */
const isNamespaced = (raw: string) => /[.:]|__/.test(raw);

/* ── the glyphs — 16px viewBox, stroke=currentColor, the inline KindIcon pattern (no icon dependency) ── */

function Read() { // an eye — view / read a file
  return (<><path d="M1.5 8S4 3.75 8 3.75 14.5 8 14.5 8 12 12.25 8 12.25 1.5 8 1.5 8Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /><circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.2" /></>);
}
function Write() { // a pencil — write a new file
  return (<path d="M11.3 2.4 13.6 4.7 6 12.3 3 13l.7-3z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />);
}
function Edit() { // a pencil over a rule — edit in place
  return (<><path d="M10.8 2.5 13 4.7 7 10.7 4.5 11.5 5.3 9z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /><path d="M3 13.5h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></>);
}
function Grep() { // a magnifier — search file contents
  return (<><circle cx="7" cy="7" r="4.2" stroke="currentColor" strokeWidth="1.2" /><path d="M10.2 10.2 14 14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></>);
}
function Find() { // a funnel — find/filter files by name
  return (<path d="M2.5 3.5h11L9.3 8.6v4.1l-2.6 1.3V8.6z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />);
}
function Ls() { // a bulleted list — list a directory
  return (<><path d="M5.5 4.5h8M5.5 8h8M5.5 11.5h8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /><circle cx="2.9" cy="4.5" r="0.9" fill="currentColor" /><circle cx="2.9" cy="8" r="0.9" fill="currentColor" /><circle cx="2.9" cy="11.5" r="0.9" fill="currentColor" /></>);
}
function Bash() { // a terminal — run a shell command
  return (<><rect x="1.75" y="3" width="12.5" height="10" rx="1.4" stroke="currentColor" strokeWidth="1.2" /><path d="M4.5 6.6 6.6 8.7 4.5 10.8M8.6 10.8h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></>);
}
function Submit() { // a checkmark — submit_result (the contract "done" tool)
  return (<path d="M2.8 8.4 6.3 12 13.2 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />);
}
function Globe() { // web_search / web_fetch
  return (<><circle cx="8" cy="8" r="5.8" stroke="currentColor" strokeWidth="1.2" /><path d="M2.3 8h11.4M8 2.2c2 2 2 9.6 0 11.6M8 2.2c-2 2-2 9.6 0 11.6" stroke="currentColor" strokeWidth="1.1" /></>);
}
function Agent() { // task / sub-agent
  return (<><circle cx="8" cy="5" r="2.4" stroke="currentColor" strokeWidth="1.3" /><path d="M3.5 13c0-2.2 2-3.6 4.5-3.6S12.5 10.8 12.5 13" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></>);
}
function Todo() { // todo — a checkbox
  return (<><rect x="2.5" y="2.5" width="11" height="11" rx="1.4" stroke="currentColor" strokeWidth="1.2" /><path d="M5.3 8 7.2 9.9 10.9 6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></>);
}
function Plug() { // an sdk/mcp namespaced tool
  return (<><path d="M6 2.5v3M10 2.5v3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /><path d="M4 5.5h8v2a4 4 0 0 1-8 0z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /><path d="M8 11.5v2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></>);
}
function Generic() { // unknown — a tag
  return (<><path d="M2.5 7.5 7.5 2.5H13v5.5L8 13z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /><circle cx="5.4" cy="5.4" r="0.9" fill="currentColor" /></>);
}

const GLYPH: Record<string, () => ReactNode> = {
  read: Read, write: Write, edit: Edit, grep: Grep, find: Find, ls: Ls, bash: Bash,
  submit_result: Submit, web_search: Globe, web_fetch: Globe, task: Agent, todo: Todo,
};

/** The inline glyph for a tool name (resolved through the alias table). Cosmetic — never blocks. */
export function ToolGlyph({ name, size = 12 }: { name: string; size?: number }) {
  const key = resolveTool(name);
  const G = GLYPH[key] ?? (isNamespaced(name) ? Plug : Generic);
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" className="ds-toolicon">
      <G />
    </svg>
  );
}

/**
 * ToolTag — the shared tool pill: an icon + the tool name label (+ an optional count). Tone-tinted via the
 * global `[data-tone]` vars. When `onClick` is given it renders as a real <button> (keyboard-reachable);
 * otherwise a static <span>. The label is the tool name; the icon carries the type at a glance.
 */
export function ToolTag({
  name, count, onClick, title, className,
}: { name: string; count?: number; onClick?: (e: ReactMouseEvent) => void; title?: string; className?: string }) {
  const cls = `ds-tooltag${className ? ` ${className}` : ""}`;
  const inner = (
    <>
      <ToolGlyph name={name} />
      <span className="ds-tooltag__label">{name}</span>
      {count != null && count > 0 && <span className="ds-tooltag__count">{count}</span>}
    </>
  );
  if (onClick) {
    return (
      <button type="button" className={`${cls} ds-tooltag--btn`} data-tone={toolTone(name)} title={title ?? name} onClick={onClick}>
        {inner}
      </button>
    );
  }
  return (
    <span className={cls} data-tone={toolTone(name)} title={title ?? name}>
      {inner}
    </span>
  );
}
