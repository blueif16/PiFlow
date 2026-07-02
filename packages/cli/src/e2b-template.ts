// Target 2 · Edit E — fail-loud pre-flight for `--sandbox e2b` on a missing E2B_TEMPLATE.
//
// Without a template id, `makeE2bProvider` boots the E2B DEFAULT BASE IMAGE (no pi baked). The node then
// runs `pi …` → 'pi: command not found' → exit 127 → nothing is written. That degrade is SILENT: the failure
// surfaces downstream as a confusing "artifact missing" and gets mis-triaged as a workflow bug — after a paid
// VM has already booted. This resolver converts it into an ACTIONABLE config error at run.ts's e2b branch,
// BEFORE the paid boot, aligned with the sibling loud-on-missing-key philosophy the e2b comment already
// documents.
//
// Contract:
//   - E2B_TEMPLATE set                → return it (the pi-baked template id).
//   - only PIFLOW_E2B_ALLOW_BASE set  → return undefined (deliberate bare-base-image boot; NO throw).
//   - neither set                     → throw a clear Error naming E2B_TEMPLATE, the exit-127 consequence,
//                                       and BOTH escapes.
//
// Fail-loud-by-default, NOT fail-closed-absolute: the `PIFLOW_E2B_ALLOW_BASE` escape hatch lets an operator
// boot the bare base image on purpose.

export function resolveE2bTemplate(env: {
  E2B_TEMPLATE?: string;
  PIFLOW_E2B_ALLOW_BASE?: string;
}): string | undefined {
  if (env.E2B_TEMPLATE) return env.E2B_TEMPLATE;
  if (env.PIFLOW_E2B_ALLOW_BASE) return undefined;
  throw new Error(
    `--sandbox e2b requires E2B_TEMPLATE (the pi-baked template id) — without it the sandbox boots the ` +
      `E2B default base image with no pi installed → 'pi: command not found' → exit 127. ` +
      `Set E2B_TEMPLATE (see deploy/e2b/build.md), or set PIFLOW_E2B_ALLOW_BASE=1 to boot the bare base image deliberately.`,
  );
}
