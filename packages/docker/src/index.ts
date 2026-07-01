// @piflow/docker — the LOCAL Docker-container sandbox backend for @piflow/core's sandbox seam,
// packaged as a CHOOSE-TO-INSTALL extension (the providers-are-extensions pattern).
//
//   install:   npm i @piflow/docker
//   use:       piflowctl run <template> --sandbox docker
//   one-liner: createDockerProvider({ image: 'piflow-node-runtime', stageHome })
//
// ONE local Docker container per run (per-node workdir subtrees, removed once), booting the SAME pi
// node-runtime image the cloud backends use (deploy/docker/Dockerfile, from the shared deploy/pi-runtime
// spec). It is the OFFLINE, FREE mirror of Daytona/E2B — same image, same credential injection, same tool
// binding — NOT a stronger isolation tier (`--sandbox local` seatbelt is finer-grained). The provider is
// dependency-free + unit-testable with a fake; `docker-sdk.ts` is the only module that spawns `docker`.

// The provider classes (the run-scoped container lifecycle behind core's Sandbox/RunScope/SandboxProvider).
export { DockerSandbox, DockerSandboxProvider } from './docker.js';

// The SDK seam types — exported so an adapter or a test can name the dependency-inversion shape.
export type {
  DockerSdk,
  DockerContainer,
  DockerFs,
  DockerProcess,
  DockerCommandHandle,
  DockerCreateParams,
  DockerRunOpts,
  DockerExecResult,
  DockerEntry,
} from './docker.js';

// Live wiring: the real `docker` CLI adapter + convenience factory (the ONLY `docker`-spawning module).
export { realDockerSdk, createDockerProvider, DEFAULT_DOCKER_IMAGE } from './docker-sdk.js';
export type { CreateDockerProviderOpts } from './docker-sdk.js';
