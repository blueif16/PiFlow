// SINGLE SOURCE OF TRUTH for the piflow "pi node-runtime" image — the container every
// sandbox backend boots to run ONE `pi` coding-agent process per workflow node:
//   • Daytona cloud VM      (declarative `Image` builder — imports this file directly)
//   • E2B cloud sandbox     (a Dockerfile shipped to `e2b template create` — GENERATED from this)
//   • local Docker (future) (a Dockerfile `docker build`s — GENERATED from this)
//
// WHY A SPEC AND NOT ONE SHARED DOCKERFILE: the builders speak different dialects — Daytona
// takes a declarative JS `Image` object (never a Dockerfile), E2B ships a Dockerfile
// server-side with NO `--build-arg`, local Docker `docker build`s a Dockerfile. A single
// Dockerfile can't feed all three, so the shared source is this DATA spec and each backend
// derives its build input from it: the Daytona *.mjs import it; the Dockerfiles are rendered
// by render-dockerfile.mjs. The ONLY thing that differs per backend is the runtime user/home
// (see `backends` below) — everything else is identical.
//
// BUMP PI (or a package / the base): edit the constants here, then run
//   node deploy/pi-runtime/render-dockerfile.mjs --write
// and re-promote the Daytona snapshot / re-`template create` the E2B template.
//
// TIER = MINIMAL+ (the rationale, kept in ONE place):
//   - node + npm .... from the base. pi requires node >=22.19.0 (engines).
//   - pi ............ the agent runtime, ABSENT from the cloud defaults. Installed as the npm
//                     global @earendil-works/pi-coding-agent (bin `pi`). `--ignore-scripts`
//                     per pi.dev's own npm instructions (no install scripts needed — also
//                     faster + avoids arbitrary postinstall).
//   - git + ca-certificates .. git for the repo clone/init a node often needs; ca-certs so
//                     pi's HTTPS model calls + any `npx <mcp-server>` fetch verify TLS.
//   - ripgrep ....... pi's built-in grep/find tools shell out to `rg`; WITHOUT it they fail.
// DELIBERATELY OMITTED (the ROBUST tier): build-essential, python, pre-baked stdio MCP
//   servers — per-node tool wiring is staged at RUNTIME by the host runner, not baked in.
//
// BASE TAG: pinned (NOT latest/lts) — Daytona's builder rejects floating tags and requires
//   linux/amd64. `node:22-trixie-slim` matches Daytona's Debian 13 trixie base and holds the
//   engine at pi's required >=22.19.0 line; E2B + local Docker use the same base for parity.

export const baseImage = 'node:22-trixie-slim';
export const piVersion = '0.80.2';
export const piPackage = '@earendil-works/pi-coding-agent';
export const aptPackages = ['git', 'ca-certificates', 'ripgrep'];

// Install OS deps + clean the apt cache in one shell fragment (one RUN layer ⇒ cache never
// persists). Shared verbatim by the Dockerfile `RUN` and the Daytona `Image.runCommands`.
const aptStep =
  'apt-get update' +
  ` && apt-get install -y --no-install-recommends ${aptPackages.join(' ')}` +
  ' && rm -rf /var/lib/apt/lists/*';

/** `npm i -g` the pinned pi. `version` defaults to `piVersion`; overridable for a test build. */
export const piInstall = (version = piVersion) => `npm install -g --ignore-scripts ${piPackage}@${version}`;

/**
 * The ONE chained RUN: OS deps → pi → prove it's runnable. Consumed verbatim by the Daytona
 * `Image.runCommands(...)` builder; the generated Dockerfiles render the same steps with a
 * `${PI_VERSION}` build-arg instead of an inlined version.
 */
export const runCommand = (version = piVersion) => `${aptStep} && ${piInstall(version)} && pi --version`;

/**
 * Daytona snapshot name for a pi version (dot-free — Daytona names are safest without dots).
 * MUST stay in sync with packages/cli/src/run.ts DEFAULT_DAYTONA_SNAPSHOT (the CLI can't
 * import from deploy/, so that constant mirrors this by hand).
 */
export const snapshotName = (version = piVersion) => `piflow-node-runtime-${version.replace(/\./g, '-')}`;

/** The ONLY per-backend divergence: runtime user + home. `user` unset ⇒ the base user is used. */
export const backends = {
  daytona: { workdir: '/home/daytona', user: { name: 'daytona', uid: 1001 } },
  e2b: { workdir: '/home/user' },
  docker: { workdir: '/home/user' }, // the future local Docker backend
};
