// ── OUTPUT CONTRACT helper — paste into your .claude/workflows/<name>.js next to discipline() ──
//
// The 4th contract layer Claude Code leaves to the orchestrator. Native Claude gives a skill
// `description` (requirements), `## Inputs`/`## Output` prose (I/O), and a return `schema` (the
// RETURN shape, validated + retried) — but it verifies the model's MESSAGE, never the FILESYSTEM.
// So each producing node declares, as DATA, the files it MUST leave on disk + the only paths it may
// write. This renders BOTH the forceful Definition-of-Done prose AND the DRIVER-ARTIFACTS /
// DRIVER-OWNS markers the generic pi driver (run.mjs) parses and verifies independent of the
// self-report — a clean exit missing a required artifact is `blocked`, not `ok`.
//
// REQUIREMENT: `artifacts`/`owns` are emitted as ABSOLUTE paths. `REPO` is your project's absolute
// package dir (the same constant your node prompts already use to address files); `artifacts`/`owns`
// are REPO-relative and get `abs()`-prefixed. `owns` defaults to `artifacts`; a trailing /* or /**
// marks a directory the node owns; `note` is an optional extra owned-path caveat.
//
// `readScope` is the node's FULL legitimate read surface — its own data/out dirs PLUS the shared
// skill/catalog roots it is pointed at (e.g. `${ROOT}/.agents`, `${REPO}/src`). EVERY producing node
// should declare one, the same tier as `owns`/`artifacts`. Its entries are ABSOLUTE and span OUTSIDE
// the package dir, so they are joined AS-IS (NOT `abs()`-prefixed). Under `--sandbox` (macOS Seatbelt)
// the rendered `DRIVER-READ-SCOPE` is OS-enforced — any read outside {toolchain ∪ scope} EPERMs,
// inherited by child grep/find/cat; without `--sandbox` the marker is inert (zero behavior change).
//
// `schema` (OPTIONAL) — the JSON-Schema the node's artifact(s) must satisfy. Renders a DRIVER-SCHEMA
// marker the driver validates the produced DRIVER-ARTIFACTS against AFTER the node (draft-2020-12-capable
// when a validator is installed — see run.mjs's schemaCheck; an invalid artifact is a BREACH → blocked,
// exactly like a missing one). The POST half of the node-contract lifecycle (PRE: seed/preflight · POST:
// artifacts existence / schema / fill-sentinel). It is a REPO-relative-or-absolute PATH joined AS-IS (a
// schema commonly lives outside the package dir, like readScope), NOT `abs()`-prefixed.
// `fillSentinel` (OPTIONAL) — a template-fill sentinel STRING (e.g. '<FILL:'); renders DRIVER-FILL-SENTINEL,
// which the in-loop write-first gate (node-contract.ts, when armed) refuses to submit_result over while any
// required artifact still contains it. The schema gate catches a leftover sentinel post-hoc anyway; this
// just gives the model immediate feedback. Both inert when omitted.
//
// Full spec: reference/artifact-contract.md (+ reference/read-scope-sandbox.md for readScope).
function contract({ artifacts = [], owns = [], readScope = [], schema = '', fillSentinel = '', note = '' }) {
  const abs = (p) => `${REPO}/${p}`
  return [
    'OUTPUT CONTRACT — you are DONE only when EVERY file below exists and is non-empty at EXACTLY its path. Write NOTHING outside the owned paths (never another run\'s files). If you cannot produce them, set status="blocked" and say why — do NOT exit clean (an empty or wrong-path artifact set is a FAILURE, not an ok).',
    `DRIVER-ARTIFACTS: ${artifacts.map(abs).join(' ')}`,
    `DRIVER-OWNS: ${(owns.length ? owns : artifacts).map(abs).join(' ')}`,
    readScope.length ? `DRIVER-READ-SCOPE: ${readScope.join(' ')}` : '',
    schema ? `DRIVER-SCHEMA: ${schema}` : '',
    fillSentinel ? `DRIVER-FILL-SENTINEL: ${fillSentinel}` : '',
    note ? `OWNED-PATH NOTE: ${note}` : '',
  ].filter(Boolean).join('\n')
}

// Usage in a node prompt array, alongside discipline():
//   const r = await agent([
//     discipline(),
//     'W0 — DO THE THING …',
//     `INPUT: ${REPO}/${P.input}.`,
//     contract({
//       artifacts: [P.output],
//       readScope: [`${REPO}/${P.dataDir}`, `${REPO}/${P.outDir}`, `${ROOT}/.agents`],
//       note: 'lesson-agnostic; touches no shared code.',
//     }),
//   ].join('\n'), { schema: NODE_RESULT })
