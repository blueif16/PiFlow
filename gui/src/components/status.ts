/**
 * Shared status helpers — the label + tone mapping used by the overlay header,
 * status pill, field blocks, and progress. Kept in one place so every surface
 * speaks the same status language.
 */
import type { NodeStatus } from "./WorkflowNode";
import type { FieldTone } from "./FieldBlock";

export const STATUS_LABEL: Record<NodeStatus, string> = {
  idle: "Idle",
  selected: "Selected",
  running: "Running",
  success: "Success",
  error: "Error",
};

export function statusTone(status: NodeStatus): FieldTone {
  if (status === "success") return "success";
  if (status === "error") return "error";
  if (status === "running" || status === "selected") return "accent";
  return "default";
}

/**
 * Status tone for a RUN ROW in the workspace switcher, mapped PURELY from the index thread's own fields
 * (`state` + `ok` — the GUI computes nothing): running → "running" (blue), failed or `ok === false` →
 * "error" (red), else "success" (green). Returns a NodeStatus subset so ProgressBar's existing
 * `data-status` recoloring (accent/success/error tokens) applies verbatim.
 */
export function runRowStatus(state: string, ok: boolean | null | undefined): Extract<NodeStatus, "running" | "success" | "error"> {
  if (state === "failed" || ok === false) return "error";
  if (state === "running") return "running";
  return "success";
}
