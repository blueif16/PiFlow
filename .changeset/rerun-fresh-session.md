---
"@piflow/core": patch
---

Fix `piflowctl node <run> <id> --rerun` (and any other COLD attempt — an escalation, a non-L1 same-model retry) warm-resuming the node's prior pi session instead of minting a fresh execution.

Root cause: `pi`'s own `--session-id <id>` is GET-OR-CREATE, not create-only — its CLI resolves the id against the session store FIRST and silently re-opens a match rather than creating (`@earendil-works/pi-coding-agent` documents this as "Use exact project session ID, creating it if missing"). Since a `--rerun` re-invokes the runner COLD in the SAME run dir with the SAME node id, and the original run already left a session file under that id, pi kept re-opening the old conversation — one session file grew across five reruns, ignoring the freshly regenerated prompt and eventually just declaring the (already-cached) work "done".

Fix: on a COLD attempt (`over.resumeSessionId` unset), the runner now archives any EXISTING session file for that node id ASIDE (renamed, never deleted — `supersedeStaleSession` in `runner/pi-session.ts`) before building the command, so pi's own get-or-create lookup finds nothing and truly creates a new file. The archived file keeps its content for observe/logs/trace recovery. The WARM op-retry lane (L1 feedback resume) is untouched — the guard only fires when `isResume` is false.
