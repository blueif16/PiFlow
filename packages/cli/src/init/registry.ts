// The init step registry — the PLUG-IN POINT. `piflowctl init` runs exactly these steps, in this order.
//
// To add a capability to setup: drop a `steps/<cap>.ts` that exports an `InitStep` and add it to this array.
// Nothing else changes — the orchestrator is capability-agnostic. CORE steps (optional:false) always run;
// OPTIONAL steps gate behind an enable prompt, so each new capability is a freely-skippable "optional check".

import type { InitStep } from './types.js';
import { modelTiersStep } from './steps/model-tiers.js';
import { claudeCodeStep } from './steps/claude-code.js';

export const INIT_STEPS: InitStep[] = [modelTiersStep, claudeCodeStep];
