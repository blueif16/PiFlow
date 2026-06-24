// Types for liveTelemetry.mjs (pure-JS shared reducer wrapper). Lets runStream.ts import it with full
// types while the runtime module stays a plain .mjs that also runs under `node` for the oracle test.
import type { LiveNode } from "./runStream";
import type { RunViewNode } from "./runView";

export function liveRunViewNode(node: LiveNode, rich: unknown): RunViewNode;

export class LiveTelemetry {
  pushEvent(nodeId: string, event: Record<string, unknown>): void;
  has(nodeId: string): boolean;
  richByNode(nodes: LiveNode[]): Record<string, RunViewNode>;
  billableTotal(): number;
}
