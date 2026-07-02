// driver-fits.test.ts — P4 of the AgentDriver registry (docs/design/agent-driver-registry.md §2.4, P4).
//
// `driverFits(node, driver)` is the author-time fit-preflight scoped to EXACTLY the 2 axes a driver adds:
//   (1) SANDBOX — can the executor run on the node's declared sandbox provider?
//   (2) TIER-VS-PIN — a model-pinning driver (describe().model.tierAware === false) cannot honor a tier.
// It DELEGATES loadout/skill/tool fit to the shipped `preflightSkills` (skill-manifest.ts:248) and MUST NOT
// re-answer it. These tests pin that contract as FAILING tests BEFORE the real body exists (the stub returns
// {ok:true, problems:[]} unconditionally). A test has value iff it FAILS when the logic is wrong:
//   • test 1 (sandbox axis) goes RED because the stub never flags a bad provider.
//   • test 2 (tier axis) goes RED because the stub never flags a tier-vs-pin mismatch.
//   • test 3 (stays-in-lane) is the GUARD — it is GREEN against the stub AND must stay green against the real
//     body (a node with an mcp loadout but fine sandbox+tier fits; driverFits does NOT re-answer loadout).
//
// The oracles are the LIVE `describe()` cards (never pasted literals): claudeCodeDriver.describe().sandbox
// .providers === ['local'] and piDriver.describe().model.tierAware === true are asserted here, so the fit
// checks are pinned to what the drivers actually declare.
import { describe, it, expect } from 'vitest';
import { driverFits } from '../src/runner/drivers/driver-fits.js';
import { piDriver } from '../src/runner/drivers/pi.js';
import { claudeCodeDriver } from '../src/runner/drivers/claude-code.js';
import type { AgentDriver, AgentDriverDescriptor } from '../src/runner/drivers/types.js';

// A fake driver = any real driver with an overridden static card. Only `describe()` is read by driverFits,
// so overriding the card is the ONLY thing that matters (the run-side methods are irrelevant here).
function withCard(base: AgentDriver, patch: Partial<AgentDriverDescriptor>): AgentDriver {
  const card = { ...base.describe(), ...patch };
  return { ...base, describe: () => card };
}

describe('driverFits — the 2 fit axes a driver adds (§2.4)', () => {
  it('AXIS 1 (sandbox): a daytona node + claude-code (providers ["local"]) FAILS, naming the allowed providers', () => {
    // Oracle: claude-code really only declares ['local'] — pinned so the assertion tracks the live card.
    const providers = claudeCodeDriver.describe().sandbox.providers;
    expect(providers).toEqual(['local']);

    const node = { sandbox: { provider: 'daytona' as const } };
    const r = driverFits(node, claudeCodeDriver);

    expect(r.ok).toBe(false);
    // The one problem must NAME the allowed provider set so the author can self-correct.
    expect(r.problems.length).toBe(1);
    expect(r.problems[0]).toContain('local'); // the allowed provider(s)
    expect(r.problems[0]).toContain('daytona'); // the offending node provider
  });

  it('AXIS 1 (sandbox): a local node + claude-code FITS (local ∈ providers ⇒ no sandbox problem)', () => {
    const node = { sandbox: { provider: 'local' as const } };
    const r = driverFits(node, claudeCodeDriver);
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
  });

  it('AXIS 2 (tier-vs-pin): node.tier + a tierAware:false driver FAILS; the SAME node + a tierAware driver FITS', () => {
    // A model-PINNING driver (tierAware:false) cannot honor a tier class → axis-2 problem.
    const pinning = withCard(piDriver, { id: 'pinning', model: { ...piDriver.describe().model, tierAware: false } });
    const node = { tier: 'deep', sandbox: { provider: 'local' as const } };

    const bad = driverFits(node, pinning);
    expect(bad.ok).toBe(false);
    expect(bad.problems.length).toBe(1);
    expect(bad.problems[0]).toContain('deep'); // names the ignored tier

    // The SAME node against a tier-AWARE driver (pi really declares tierAware:true) fits on both axes.
    expect(piDriver.describe().model.tierAware).toBe(true); // oracle
    const good = driverFits(node, piDriver);
    expect(good.ok).toBe(true);
    expect(good.problems).toEqual([]);
  });

  it('STAYS IN LANE: an mcp-loadout node with fine sandbox+tier FITS — driverFits does NOT re-answer the loadout question', () => {
    // This node's tools/skills are a `preflightSkills` concern (an mcp.* tool → a skill-manifest `requires`),
    // NOT a driver-fit concern. Its sandbox (local ∈ claude providers) and tier (claude is tierAware) are both
    // fine, so driverFits MUST return ok:true — proving it did not re-derive the loadout/skill fit that
    // skill-manifest.ts:248 already owns. If driverFits ever grew a tools/skills branch, this would flip RED.
    const node = {
      sandbox: { provider: 'local' as const },
      // no tier pin; the loadout below is deliberately something preflightSkills — not driverFits — governs.
      tools: { allow: ['mcp.exa.search'] },
      tier: undefined,
    };
    const r = driverFits(node, claudeCodeDriver);
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
  });
});
