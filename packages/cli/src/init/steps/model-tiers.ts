// CORE step — your pi provider's model tiers (`fast` / `balanced` / `deep`). Always runs (the base config a
// fresh ~/.piflow starts from). Each tier defaults to its CURRENT value, so pressing enter keeps it. REUSES
// the granular `model set` logic (`applyModelCommand`) so the wizard and `piflowctl model set` write byte-
// identically. Touches ONLY the pi `tiers` map — never the parallel `claude` block (that is the optional
// claude-code step's concern; the two model surfaces are kept strictly separate).

import { loadModelTiers, writeModelTiers, CANONICAL_TIERS } from '@piflow/core';
import { applyModelCommand } from '../../model.js';
import type { InitStep } from '../types.js';

/** A short example id per tier, shown in the prompt so the user knows the shape expected. */
const EXAMPLE: Record<string, string> = {
  fast: 'deepseek-v3',
  balanced: 'sonnet',
  deep: 'claude-opus-4-8',
};

export const modelTiersStep: InitStep = {
  id: 'model-tiers',
  title: 'Model tiers — your pi provider models (enter to keep current)',
  optional: false,
  async run(ctx) {
    let tiers = loadModelTiers(ctx.tiersFile);
    const set: string[] = [];
    for (const tier of CANONICAL_TIERS) {
      const cur = tiers.tiers[tier] ?? '';
      const ans = await ctx.io.input(`  ${tier} model id (e.g. ${EXAMPLE[tier] ?? '…'})`, cur);
      if (ans && ans !== cur) {
        // Reuse the exact `model set <tier> <id>` mutation (sets the pi tier + flips active:true).
        tiers = applyModelCommand(tiers, ['set', tier, ans]).next;
        set.push(`${tier}=${ans}`);
      }
    }
    if (set.length) writeModelTiers(tiers, ctx.tiersFile);
    return {
      id: 'model-tiers',
      status: 'done',
      detail: set.length ? `set ${set.join(' ')} (active)` : 'kept current',
    };
  },
};
