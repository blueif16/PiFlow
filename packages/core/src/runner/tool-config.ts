// TEMPORARY STUB — un-seeded registry, so the M1 test FAILS for the RIGHT (behavioral) reason
// (`oc.calc:add` reported MISSING), not a missing-module error. Replaced by the real implementation next.
import type { WorkflowSpec, ToolEntry, ToolRegistry } from '../types.js';
import { DefaultToolRegistry } from '../tools/registry.js';

export interface AssembleRunToolsInput {
  spec: WorkflowSpec;
  extraEntries?: ToolEntry[];
  mcpListings?: Record<string, ToolEntry[]>;
}
export interface AssembledRunTools {
  registry: ToolRegistry;
  mcpConfig?: { servers: Record<string, unknown> };
}

export function assembleRunTools(_input: AssembleRunToolsInput): AssembledRunTools {
  return { registry: new DefaultToolRegistry() };
}
