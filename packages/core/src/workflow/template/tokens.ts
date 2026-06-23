// Token helpers for the template loader. The path/value vocabulary is `{{RUN}}` · `{{WORKSPACE}}` ·
// `{{state.<channel>}}` (template-format.md §7). The delimiter is PROVISIONAL (§11) — keep it behind a
// single constant so it can change in one place. The loader's §8 checks need to (a) detect a `{{RUN}}`-
// relative path, (b) strip the `{{RUN}}/` prefix to get the run-relative artifact path, and (c) collect
// the `{{state.X}}` channels a string consumes.

/** The provisional token delimiters (§11) — change here only. */
const OPEN = '{{';
const CLOSE = '}}';

const reToken = (inner: string): RegExp =>
  new RegExp(escapeRe(OPEN) + '\\s*' + inner + '\\s*' + escapeRe(CLOSE), 'g');
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every `{{state.<channel>}}` channel name a string consumes (deduped, in order). */
export function stateChannels(s: string): string[] {
  const re = reToken('state\\.([A-Za-z0-9_]+)');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** True iff the path is rooted at `{{RUN}}` (a per-thread, run-relative path) — the artifacts we route. */
export function isRunRooted(p: string): boolean {
  return reToken('RUN').test(p);
}

/** True iff the path is rooted at `{{WORKSPACE}}` (a canonical, out-of-thread read we do NOT route). */
export function isWorkspaceRooted(p: string): boolean {
  return reToken('WORKSPACE').test(p);
}

/**
 * Strip a leading `{{RUN}}/` (or a bare run-relative path) down to the run-relative artifact path used
 * for producer matching. A `{{WORKSPACE}}`-rooted or `{{state}}`-bearing path returns null (not routed).
 */
export function runRelative(p: string): string | null {
  if (isWorkspaceRooted(p)) return null;
  if (stateChannels(p).length) return null;
  const stripped = p.replace(reToken('RUN'), '').replace(/^\/+/, '');
  return stripped || null;
}
