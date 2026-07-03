// `searchRemote` — MOVED to @piflow/core (workflow/ops/skill-remote.ts, 2026-07-03) so the CLI verb AND
// the control-plane server (the GUI marketplace panel's online search) share ONE implementation. This shim
// keeps the CLI-internal `./skill-remote.js` import path (and its test suites) stable; the probed API
// facts + source contracts live in the core module's header.
export { searchRemote, remoteSourceIds } from '@piflow/core';
export type { RemoteSkillRow, SearchRemoteOpts } from '@piflow/core';
