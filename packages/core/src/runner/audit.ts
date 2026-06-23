// Static pre-run audit over a COMPILED workflow — the "see every agent's tool surface before you spend
// a model call" check. A consumer that has built its `Workflow` (post-bridge) runs this to catch the
// binding bugs that are otherwise invisible until the model itself complains mid-run (the gate-3
// never-write was an un-tokenized DRIVER-TOOLS list → pi bound only the first tool). Pure → testable.

import type { Workflow } from '../types.js';

export interface NodeToolAudit {
  id: string;
  allow: string[];
  deny: string[];
  /** Human-readable problems with this node's tool binding (empty = clean). */
  findings: string[];
}

/**
 * Audit every node's tool surface. Flags:
 *  - an allow/deny ENTRY containing whitespace — an un-tokenized list; pi binds only the first word and
 *    treats the rest as positional args (the node silently can't use the "missing" tools, e.g. write);
 *  - a tool that is BOTH allowed and denied (the deny wins → a surprise missing tool).
 */
export function auditWorkflow(wf: Workflow): NodeToolAudit[] {
  const out: NodeToolAudit[] = [];
  for (const id of Object.keys(wf.nodes)) {
    const t = (wf.nodes[id].tools ?? {}) as { allow?: string[]; deny?: string[] };
    const allow = t.allow ?? [];
    const deny = t.deny ?? [];
    const findings: string[] = [];
    for (const e of [...allow, ...deny]) {
      if (/\s/.test(e)) findings.push(`un-tokenized tool entry ${JSON.stringify(e)} — pi binds only the first word; the rest become positional args`);
    }
    const both = allow.filter((a) => deny.includes(a));
    if (both.length) findings.push(`tool(s) both allowed and denied (deny wins): ${both.join(', ')}`);
    out.push({ id, allow, deny, findings });
  }
  return out;
}

/** True iff any node has a tool-binding finding (a consumer can hard-fail a preflight on this). */
export function hasToolFindings(audits: NodeToolAudit[]): boolean {
  return audits.some((a) => a.findings.length > 0);
}
