// distill.mjs — a STREAM REDUCER over one node's pi event stream.
//
// THE design (per the io.json architecture): the pi event stream is the SINGLE source, flowing
// one-directional. `events.jsonl` and `io.json` are two INDEPENDENT listeners on it — io.json does
// not re-read events.jsonl, it co-listens and grabs only the updates it cares about. This reducer
// IS that listener, and it runs identically in two modes with zero divergence:
//   • live (real SDK): the runner's recorder tee calls push(e) per event as it streams.
//   • replay (the fake run / transcoder): we read a recorded events.jsonl and push each line.
//
// finalize(statusRec) returns:
//   • rich — everything a HUD wants (model/provider, toolBreakdown, per-tool timeline, reads,
//            writes, bash, tokens, timing). Derived purely from the stream (+ artifacts for verify).
//   • io   — the lean NodeIo ledger (@piflow/core types.ts NodeIo): reads/writes/promotes/timing.
//
// pi tool vocabulary observed: bash, read, edit, write, grep, ls, find, submit_result.
const READ_TOOLS = new Set(['read', 'grep']);   // file CONTENT reads → "input files"
const LIST_TOOLS = new Set(['ls', 'find']);      // directory listings → scope touches, not file reads
const WRITE_TOOLS = new Set(['edit', 'write']);  // file writes → "outputs"

const baseName = (p) => (typeof p === 'string' ? p.split('/').pop() : p);

// Pull the human-readable text out of a tool result ({ content: [{type:'text', text}] }), capped — so
// the HUD's "hover a read → see the file" shows the REAL bytes the agent read, not a placeholder.
const PREVIEW_CAP = 8000;
function resultText(result) {
  if (!result || !Array.isArray(result.content)) return undefined;
  const text = result.content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n');
  if (!text) return undefined;
  return text.length > PREVIEW_CAP ? text.slice(0, PREVIEW_CAP) : text;
}

export function createNodeAccumulator() {
  const reads = new Map();   // path → { path, via, tStartMs }  (first touch wins; de-duped by path)
  const lists = new Map();   // path → { path, via }
  const writes = new Map();  // path → { path, via, tStartMs }
  const bash = [];           // { command, tStartMs, durMs, ok }
  const toolBreakdown = {};  // toolName → count
  const open = new Map();    // toolCallId → { name, tStartMs }  (spans awaiting their _end)
  const timeline = [];       // { name, tStartMs, durMs, ok }  (one per completed tool call)
  let toolCalls = 0;
  let model = null, provider = null, api = null;
  let firstT = null, lastT = null, firstRt = null, lastRt = null;
  const tok = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextPeak: 0 };
  // ROBUST data-load monitoring: count EVERY event the reducer sees (by type) + how many carried
  // usage, so a consumer can prove no event was silently dropped and see where tokens came from.
  let eventsSeen = 0, usageEvents = 0;
  const byType = {};

  const seeT = (e) => {
    if (typeof e._t === 'number') { if (firstT == null || e._t < firstT) firstT = e._t; if (lastT == null || e._t > lastT) lastT = e._t; }
    if (typeof e._rt === 'string') { if (!firstRt) firstRt = e._rt; lastRt = e._rt; }
  };

  // pi reports per-call cost as an OBJECT {input,output,cacheRead,cacheWrite,total} (some providers a
  // scalar, some 0). Reduce to ONE number so `cost += …` can never string-concat to "0[object Object]".
  const costScalar = (c) => {
    if (typeof c === 'number') return c;
    if (c && typeof c === 'object') {
      return typeof c.total === 'number' ? c.total : (c.input || 0) + (c.output || 0) + (c.cacheRead || 0) + (c.cacheWrite || 0);
    }
    return 0;
  };
  // Capture model/provider/api from the FIRST assistant message that names them (start or end).
  const seeModel = (m) => {
    if (m && m.role === 'assistant' && !model && m.model) { model = m.model; provider = m.provider ?? provider; api = m.api ?? api; }
  };
  // Fold ONE assistant message's per-call usage into the running totals. input/output/cache* are
  // per-call → SUM; totalTokens is the per-call context size → take the MAX (contextPeak).
  const addUsage = (u) => {
    if (!u || typeof u !== 'object') return;
    usageEvents += 1;
    tok.input += u.input || 0; tok.output += u.output || 0;
    tok.cacheRead += u.cacheRead || 0; tok.cacheWrite += u.cacheWrite || 0;
    tok.cost += costScalar(u.cost);
    if ((u.totalTokens || 0) > tok.contextPeak) tok.contextPeak = u.totalTokens;
  };

  return {
    push(e) {
      if (!e || typeof e !== 'object') return;
      eventsSeen += 1;
      byType[e.type] = (byType[e.type] || 0) + 1;
      seeT(e);
      switch (e.type) {
        // message_start: capture model/provider/api. Its usage is ~always zero (the call hasn't run
        // yet), so tokens are NOT read here — they land on message_end below.
        case 'message_start':
          seeModel(e.message);
          break;
        // message_end carries the per-call FINAL usage (input/output filled in). This is THE token
        // source. `turn_end` carries an IDENTICAL 1:1 rollup of the same usage, so reading it too
        // would DOUBLE-count — we deliberately ignore turn_end for usage.
        case 'message_end':
          seeModel(e.message);
          if (e.message && e.message.role === 'assistant') addUsage(e.message.usage);
          break;
        case 'tool_execution_start': {
          toolCalls += 1;
          const name = e.toolName;
          toolBreakdown[name] = (toolBreakdown[name] || 0) + 1;
          const p = e.args && e.args.path;
          open.set(e.toolCallId, { name, tStartMs: e._t ?? null, path: READ_TOOLS.has(name) ? p : null });
          if (READ_TOOLS.has(name) && p) { if (!reads.has(p)) reads.set(p, { path: p, via: name, tStartMs: e._t ?? null }); }
          else if (LIST_TOOLS.has(name) && p) { if (!lists.has(p)) lists.set(p, { path: p, via: name }); }
          else if (WRITE_TOOLS.has(name) && p) { if (!writes.has(p)) writes.set(p, { path: p, via: name, tStartMs: e._t ?? null }); }
          else if (name === 'bash' && e.args && e.args.command) bash.push({ command: e.args.command, tStartMs: e._t ?? null });
          break;
        }
        case 'tool_execution_end': {
          const span = open.get(e.toolCallId);
          if (span) {
            const durMs = (e._t != null && span.tStartMs != null) ? Math.max(0, e._t - span.tStartMs) : 0;
            timeline.push({ name: span.name, tStartMs: span.tStartMs, durMs, ok: !e.isError });
            // capture the REAL read content once, for the "hover → see the file" detail view
            if (span.path && reads.has(span.path) && !reads.get(span.path).preview) {
              const preview = resultText(e.result);
              if (preview) reads.get(span.path).preview = preview;
            }
            open.delete(e.toolCallId);
          }
          break;
        }
        default: break; // turn_*, message_update/end, agent_*, session, tool_execution_update — ignored
      }
    },

    finalize(statusRec = {}) {
      // close any tool spans that never saw an _end (killed mid-call) so timeline stays 1:1 with calls
      for (const span of open.values()) timeline.push({ name: span.name, tStartMs: span.tStartMs, durMs: 0, ok: true });
      open.clear();

      // verified-not-trusted: a write is "verified" only if a real on-disk artifact matches it.
      const artByBase = new Map((statusRec.artifacts || []).map((a) => [baseName(a.path), a]));
      const writeArr = [...writes.values()].map((w) => {
        const a = artByBase.get(baseName(w.path));
        return { path: w.path, via: w.via, tStartMs: w.tStartMs, verified: !!(a && a.exists), bytes: a ? a.bytes : undefined };
      });

      const startedAt = statusRec.startedAt || firstRt || undefined;
      const endedAt = statusRec.endedAt || lastRt || undefined;
      const durationMs = statusRec.durationMs ?? ((firstT != null && lastT != null) ? lastT - firstT : undefined);

      const rich = {
        model, provider, api,
        toolCalls, toolBreakdown, timeline,
        reads: [...reads.values()],
        lists: [...lists.values()],
        writes: writeArr,
        bash,
        tokens: { ...tok, billable: tok.input + tok.output },
        // data-load audit: total events folded, the per-type histogram, and how many carried usage.
        // Lets the caller verify the reducer SAW every recorded event (eventsSeen) and where tokens
        // came from (usageEvents) — the robust "we didn't lose data" check.
        coverage: { eventsSeen, usageEvents, byType },
        startedAt, endedAt, durationMs,
      };

      const io = {
        reads: [...reads.values()].map((r) => ({ path: r.path, via: r.via })),
        writes: writeArr.map((w) => ({ path: w.path, verified: w.verified, bytes: w.bytes })),
        promotes: [],
        startedAt, endedAt, durationMs,
      };

      return { rich, io };
    },
  };
}
