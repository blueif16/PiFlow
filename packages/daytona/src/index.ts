// @piflow/daytona — the Daytona cloud-sandbox backend for @piflow/core's sandbox seam, packaged as a
// CHOOSE-TO-INSTALL extension (the providers-are-extensions pattern).
//
//   install:   npm i @piflow/daytona
//   use:       piflowctl run <template> --sandbox daytona
//   one-liner: createDaytonaProvider({ apiKey: process.env.DAYTONA_API_KEY, snapshot, autoStopInterval })
//
// ONE long-lived Daytona VM per run (per-node workdir subtrees, torn down once). Boot from a pre-built
// SNAPSHOT (the promoted `piflow-node-runtime`) or a raw image ref; the pi gateway credential crosses
// into the VM via the runner's cloud allowlist. The provider is dependency-free + unit-testable with a
// fake; `daytona-sdk.ts` is the only module that imports the real `@daytona/sdk`.

// The provider classes (the run-scoped VM lifecycle behind core's Sandbox/RunScope/SandboxProvider).
export { DaytonaSandbox, DaytonaSandboxProvider } from './daytona.js';

// The SDK seam types — exported so an adapter or a test can name the dependency-inversion shape.
export type {
  DaytonaSdk,
  DaytonaVm,
  DaytonaFs,
  DaytonaProcess,
  DaytonaCreateParams,
  DaytonaExecResponse,
  DaytonaSessionCommand,
  DaytonaSessionCommandInfo,
} from './daytona.js';

// Live wiring: the real `@daytona/sdk` adapter + convenience factory (the ONLY SDK-importing module).
export { realDaytonaSdk, createDaytonaProvider } from './daytona-sdk.js';
export type { CreateDaytonaProviderOpts } from './daytona-sdk.js';
