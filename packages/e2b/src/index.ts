// @piflow/e2b — the E2B open-egress cloud-sandbox backend for @piflow/core's sandbox seam,
// packaged as a CHOOSE-TO-INSTALL extension (the providers-are-extensions pattern).
//
//   install:   npm i @piflow/e2b
//   use:       piflowctl run <template> --sandbox e2b
//   one-liner: createE2bProvider({ apiKey: process.env.E2B_API_KEY, template, timeoutMs })
//
// ONE long-lived E2B sandbox per run (per-node workdir subtrees, killed once), with OPEN egress by
// default — the unblock for heterogeneous/remote MCP tools that Daytona's tier-gated egress can't
// serve. The provider is dependency-free + unit-testable with a fake; `e2b-sdk.ts` is the only module
// that imports the real `e2b` SDK.

// The provider classes (the run-scoped VM lifecycle behind core's Sandbox/RunScope/SandboxProvider).
export { E2bSandbox, E2bSandboxProvider } from './e2b.js';

// The SDK seam types — exported so an adapter or a test can name the dependency-inversion shape.
export type {
  E2bSdk,
  E2bVm,
  E2bFs,
  E2bProcess,
  E2bCommandHandle,
  E2bCreateParams,
  E2bRunOpts,
  E2bExecResult,
  E2bEntry,
} from './e2b.js';

// Live wiring: the real `e2b` adapter + convenience factory (the ONLY SDK-importing module).
export { realE2bSdk, createE2bProvider } from './e2b-sdk.js';
export type { CreateE2bProviderOpts } from './e2b-sdk.js';
