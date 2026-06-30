// `piflowctl init` — the modular setup wizard. This file is the CONTRACT every step plugs into.
//
// The wizard is deliberately fragmented: the orchestrator (`run.ts`) knows nothing about model tiers or
// Claude Code — it just walks an ordered list of `InitStep`s (the registry), gating each OPTIONAL step
// behind an enable prompt. A capability is added by dropping ONE `steps/<cap>.ts` that exports an
// `InitStep` and registering it; nothing else changes. Each step REUSES the granular CLI logic we already
// shipped (`applyModelCommand`, `resolveConnectToken`, `writeClaudeCodeCred`) rather than duplicating it.
//
// I/O is injected via `PromptIO` so a step is a PURE function of its answers + the on-disk paths in its
// `InitContext` — that is what makes a step testable with a scripted IO + a temp home, no real readline.

/** The interactive surface a step talks through. The real impl wraps node:readline; tests inject a script. */
export interface PromptIO {
  /** Emit one line to the user (section headers, detected state, hints). */
  print(line: string): void;
  /** A yes/no gate. Returns `def` on an empty answer. */
  confirm(question: string, def: boolean): Promise<boolean>;
  /** A free-text answer, trimmed. Returns `def` (default '') on an empty answer — so a caller passing the
   *  CURRENT value as `def` gets "press enter to keep / skip". */
  input(question: string, def?: string): Promise<string>;
}

/** The on-disk targets + detected facts a step operates over — threaded so tests point them at a temp home. */
export interface InitContext {
  io: PromptIO;
  /** `~/.piflow/model-tiers.json` (PIFLOW_HOME-aware via core's homeTiersFile). */
  tiersFile: string;
  /** `~/.piflow/claude-code.json` (the explicit, portable Claude Code credential). */
  credFile: string;
  /** Whether a `claude` executable is on $PATH (detected once, shown to the user). */
  claudeOnPath: boolean;
}

/** What a step did, for the closing summary. `skipped` = an optional step whose gate was declined. */
export interface StepResult {
  id: string;
  status: 'done' | 'skipped';
  detail: string;
}

/** One pluggable setup step. CORE steps always run; OPTIONAL steps ask `gate` first (decline ⇒ skipped,
 *  `run` is never called — the "plug it in, it adds optional checks; skip it, you're the pure default"). */
export interface InitStep {
  id: string;
  /** The section header printed before the step. */
  title: string;
  /** OPTIONAL ⇒ gate behind an enable prompt; CORE (false) ⇒ always run. */
  optional: boolean;
  /** The enable prompt for an optional step (ignored for core steps). */
  gate?: string;
  run(ctx: InitContext): Promise<StepResult>;
}
