/**
 * node-contract — GENERIC pi extension for the pi-runner harness. Copy this file verbatim; it takes
 * NO repo-specific edits (it is configured per node via env the driver sets). Loaded with `-e`
 * (explicit -e still loads under --no-extensions), opt-in via PI_RUNNER_CONTRACT_EXT.
 *
 * It gives the headless `-p` driver two things a plain stdout-scrape cannot:
 *
 *   1. submit_result — a TYPED, terminating return tool. The node ENDS by CALLING it; pi validates
 *      the args against the schema, so the non-Claude model can't botch a ```json fence (the single most-
 *      patched surface in run.mjs: 98fcdd3 → 89fe3ac). The structured `details` reach the driver on
 *      the `tool_execution_end` json event; `terminate:true` saves the extra follow-up LLM turn.
 *      The driver still keeps its fenced-JSON parser as a fallback, so this is strictly non-breaking.
 *
 *   2. owned-paths block — a `tool_call` hook that BLOCKS any write/edit landing outside this node's
 *      lane (PI_NODE_OWNS = space-separated globs the driver derives from the node's DRIVER-OWNS
 *      marker). In-loop PREVENTION with immediate model feedback, vs the driver's post-hoc, self-
 *      reported owns check. This closes the cross-contamination class (a node writing a SIBLING
 *      lesson's file) at the moment of the write. Best-effort: it gates `write`/`edit` (whose target
 *      is `input.path`); a shell redirect inside `bash` can still bypass it, so the driver's post-hoc
 *      check + worktree-per-run remain the backstop for bash writes.
 *
 *   3. write-first gate — the ARTIFACT-ON-DISK invariant, enforced IN-LOOP so a node cannot end by
 *      RETURNING its required artifact inline instead of WRITING it (the V01 failure: a Harden node
 *      that built the whole blueprint in its head, called submit_result, and left spec/blueprint.json
 *      absent). PI_NODE_REQUIRE = space-separated paths the driver derives from the node's
 *      DRIVER-ARTIFACTS marker. Two layers:
 *        (a) PRIMARY — a `tool_call` hook BLOCKS `submit_result` while any required path is missing or
 *            empty on disk, with a corrective reason. The model literally cannot terminate without
 *            having written the file. This is solid: tool_call blocks are synchronous and authoritative.
 *        (b) SECONDARY (guard) — an `agent_end` hook that, if the loop is ending with a required path
 *            still missing (e.g. the model stopped WITHOUT calling submit_result), re-prompts ONCE via
 *            sendUserMessage(..., {deliverAs:"followUp"}). pi's run loop is
 *            `await agent.prompt(); while (await _handlePostAgentRun()) await agent.continue();` and
 *            _handlePostAgentRun() returns agent.hasQueuedMessages() AFTER awaiting the agent_end
 *            extension handlers (agent-session.js:358,659,688-690) — so a followUp queued here is read
 *            before the run terminates. NON-FATAL by construction: if the re-prompt does nothing, the
 *            driver's post-hoc contractMissing→`blocked` check (run.mjs) is the floor — worst case is a
 *            clean `blocked`, never a false-green.
 *      The whole gate is INERT unless the driver set PI_NODE_REQUIRE (i.e. the node declared
 *      DRIVER-ARTIFACTS) AND the extension is loaded — backward-compatible by construction.
 *      CONTENT layer (optional): when the driver also set PI_NODE_FILL_SENTINEL (from a node's
 *      DRIVER-FILL-SENTINEL marker, e.g. "<FILL:"), "satisfied" means EXISTS ∧ non-empty ∧ contains NO
 *      sentinel — so a pre-seeded SCHEMA-SHAPED skeleton (DRIVER-SEED) that still holds an unfilled leaf
 *      is blocked too. This is the in-loop COMPLEMENT of the driver's post-node DRIVER-SCHEMA gate (an
 *      unreplaced sentinel also violates the schema's type/enum, so it is caught post-hoc regardless).
 *
 * Resolution note: pi's extension loader BUNDLES `typebox` and `@earendil-works/pi-coding-agent`
 * (dist/core/extensions/loader.js), so these imports resolve even though this file lives outside
 * pi's node_modules. (The existing providers/coding-plan.ts proves the -e load path.)
 */
import fs from "node:fs";
import path from "node:path";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const submitResult = defineTool({
  name: "submit_result",
  label: "Submit node result",
  description:
    "Return this node's FINAL structured result. Call this as your LAST action, after writing every " +
    "required output file AND the _logs entry. Do not emit another message after calling it.",
  promptSnippet: "End the node by calling submit_result with the structured outcome (do not also print a JSON block).",
  promptGuidelines: [
    "Call submit_result exactly once, as the final action, after all output files exist on disk.",
    "status='ok' ONLY if every required artifact was written; otherwise 'gap' or 'blocked' with the reason in summary.",
    "outputArtifacts = the repo-relative paths you actually wrote.",
  ],
  parameters: Type.Object({
    node: Type.String({ description: "this node's label" }),
    status: Type.Union([Type.Literal("ok"), Type.Literal("gap"), Type.Literal("blocked")], {
      description: "node outcome — ok only if every required artifact is on disk",
    }),
    outputArtifacts: Type.Array(Type.String(), { description: "repo-relative paths you wrote", default: [] }),
    summary: Type.String({ description: "1-2 sentence outcome" }),
    issues: Type.Array(Type.String(), { description: "problems encountered", default: [] }),
    pipelineFindings: Type.Array(Type.String(), { description: "workflow-improvement findings", default: [] }),
  }),
  async execute(_toolCallId, params) {
    return {
      content: [{ type: "text", text: `submitted: ${params.node} → ${params.status}` }],
      details: params,
      terminate: true,
    };
  },
});

function withinOwned(absTarget: string, globs: string[]): boolean {
  return globs.some((g) => {
    // Strip a trailing /** , /* or / to get the lane ROOT, then resolve it to absolute the SAME way
    // the target (above) and requireMissing (below) resolve — pi runs with cwd = the driver's RUN_CWD.
    // A DRIVER-OWNS glob is repo-relative (e.g. "out/<id>/spec/**"), so it MUST be made absolute before
    // comparing; otherwise an absolute write target can never match a relative base and EVERY in-lane
    // write/edit is wrongly blocked ("outside this node's owned lane"), forcing the model off native
    // write/edit onto bash heredocs.
    const rel = g.replace(/\/\*\*?$/, "").replace(/\/$/, "");
    const base = path.isAbsolute(rel) ? rel : path.resolve(process.cwd(), rel);
    return absTarget === base || absTarget.startsWith(base + "/");
  });
}

// Which of the node's REQUIRED artifacts (PI_NODE_REQUIRE) are still absent or empty on disk. pi runs
// with cwd = the driver's RUN_CWD, so a relative required path resolves there (the same base the driver
// uses); absolute paths pass through. A 0-byte file counts as missing (matches the driver's size>0 rule).
function requireMissing(required: string[]): string[] {
  return required.filter((p) => {
    const abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
    try { return fs.statSync(abs).size === 0; } catch { return true; }
  });
}

// Which REQUIRED artifacts still contain the template-fill SENTINEL (PI_NODE_FILL_SENTINEL, e.g. "<FILL:").
// A node pre-seeded a SCHEMA-SHAPED template (DRIVER-SEED) is DONE only when every sentinel is replaced —
// a present-but-unfilled skeleton passes requireMissing (exists ∧ non-empty) yet is NOT a satisfied
// contract. This makes "the artifact is FILLED" a structural invariant instead of a prose hope. Empty
// sentinel ⇒ no check (back-compat). Same path resolution as requireMissing.
function requireUnfilled(required: string[], sentinel: string): string[] {
  if (!sentinel) return [];
  return required.filter((p) => {
    const abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
    try { return fs.readFileSync(abs, "utf8").includes(sentinel); } catch { return false; }
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerTool(submitResult);

  // Owned-paths in-loop block — active only when the driver set PI_NODE_OWNS for this node.
  const owns = (process.env.PI_NODE_OWNS || "").split(/\s+/).filter(Boolean);
  if (owns.length) {
    pi.on("tool_call", async (event, _ctx) => {
      if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
      const raw = (event.input as { path?: string })?.path;
      if (!raw) return undefined;
      // pi runs with cwd = the driver's RUN_CWD; resolve a relative target the same way the driver does.
      const absTarget = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
      if (!withinOwned(absTarget, owns)) {
        return { block: true, reason: `path "${raw}" is outside this node's owned lane (DRIVER-OWNS: ${owns.join(" ")})` };
      }
      return undefined;
    });
  }

  // WRITE-FIRST GATE — active only when the driver set PI_NODE_REQUIRE (the node declared
  // DRIVER-ARTIFACTS). Enforces the artifact-on-disk invariant a structural altitude above prose.
  // The optional PI_NODE_FILL_SENTINEL (the driver sets it from a node's DRIVER-FILL-SENTINEL marker,
  // e.g. "<FILL:") adds a CONTENT check on top of the EXISTENCE check: a required artifact that was
  // pre-seeded as a SCHEMA-SHAPED skeleton (DRIVER-SEED) and still holds the sentinel exists ∧ is
  // non-empty (passes requireMissing) yet is NOT a satisfied contract — it is unfilled. So an artifact
  // is "done" only when it both EXISTS and contains NO sentinel. This is the in-loop COMPLEMENT of the
  // driver's post-node DRIVER-SCHEMA gate (an unreplaced <FILL:> also breaks the schema's type/enum and
  // would be caught post-hoc regardless); the in-loop sentinel just gives the model immediate feedback.
  const required = (process.env.PI_NODE_REQUIRE || "").split(/\s+/).filter(Boolean);
  const fillSentinel = process.env.PI_NODE_FILL_SENTINEL || "";
  // The set of required paths NOT yet satisfied = missing/empty UNION still-unfilled (sentinel present).
  const unsatisfied = (): string[] => {
    const missing = requireMissing(required);
    const unfilled = requireUnfilled(required, fillSentinel).filter((p) => !missing.includes(p));
    return [...missing, ...unfilled];
  };
  if (required.length) {
    // (a) PRIMARY — BLOCK submit_result while a required artifact is missing/empty OR still holds the
    // template-fill sentinel. The node literally cannot terminate by returning its artifact inline, nor
    // by leaving an unfilled skeleton; it must WRITE the complete file first.
    pi.on("tool_call", async (event, _ctx) => {
      if (event.toolName !== "submit_result") return undefined;
      const missing = requireMissing(required);
      const unfilled = fillSentinel ? requireUnfilled(required, fillSentinel).filter((p) => !missing.includes(p)) : [];
      if (missing.length) {
        return {
          block: true,
          reason:
            `cannot submit_result yet — write ${missing.length === 1 ? "this required artifact" : "these required artifacts"} ` +
            `to disk first (non-empty): ${missing.join(", ")}. The artifact is the FILE you write, not the value you return; ` +
            `write it, verify it exists, then call submit_result.`,
        };
      }
      if (unfilled.length) {
        return {
          block: true,
          reason:
            `cannot submit_result yet — ${unfilled.length === 1 ? "this required artifact" : "these required artifacts"} still ` +
            `contain the unfilled template sentinel "${fillSentinel}": ${unfilled.join(", ")}. Replace EVERY ${fillSentinel}… leaf ` +
            `with its real value (the skeleton is not the deliverable), then call submit_result.`,
        };
      }
      return undefined;
    });

    // (b) SECONDARY (guard) — if the loop is ending with a required artifact still missing OR unfilled
    // (the model stopped WITHOUT submit_result, so the block above never fired), re-prompt ONCE. Verified
    // ordering: pi awaits agent_end handlers before _handlePostAgentRun() checks hasQueuedMessages(), so a
    // followUp queued here is consumed before the run terminates (agent-session.js). One-shot via
    // reReminded; non-fatal — the driver's post-hoc contractMissing/schemaInvalid→blocked check is the floor.
    let reReminded = false;
    pi.on("agent_end", async (_event, _ctx) => {
      if (reReminded) return undefined;
      const pending = unsatisfied();
      if (!pending.length) return undefined;
      reReminded = true;
      const why = requireMissing(required).length
        ? `still missing on disk`
        : `present but still hold the unfilled template sentinel "${fillSentinel}"`;
      pi.sendUserMessage(
        `You are about to end this node, but a REQUIRED output artifact is ${why}: ${pending.join(", ")}. ` +
          `Write ${pending.length === 1 ? "it" : "them"} now (non-empty, fully filled, at exactly that path), then call submit_result. ` +
          `The artifact is the FILE — returning its contents inline, or leaving the skeleton unfilled, does not satisfy the contract.`,
        { deliverAs: "followUp" },
      );
      return undefined;
    });
  }
}
