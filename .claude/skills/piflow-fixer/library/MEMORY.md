# Index — one line per card (hint = description, verbatim)

## objectives
- [Declared budgets turn "never satisfied" into typed defects](cards/budgets-as-defects.md) — Reach for this when a green run is slow/costly and unrecorded, or killed for an undeclared "too long" — declare budgets that file defects, never grades.
- [Using LLM judges without inheriting their false confidence](cards/judge-reliability.md) — Reach for this when a gate asks a model to judge quality — swap absolute scoring, self-review, and confidence trust for ranking, rubrics, and outcomes.
- [What a self-improving system optimizes for (quality floor, efficiency pressure)](cards/optimization-objective-shape.md) — Reach for this when designing/reviewing an accept gate or optimizer score — quality gates, efficiency is a scored defect class, never fuse them.
- [Tiered scoring: deterministic first, judgment last, abstain to the human](cards/scoring-cascade.md) — Use when scoring a run or gating an edit-accept — cascade deterministic checks before any judge, and abstain to a human rather than guess quality.

## loops
- [Two-axis defect routing — agentic (mechanism) vs quality (judged output)](cards/agentic-vs-quality-routing.md) — Classify each flaw agentic (trace-detected mechanism) vs quality (judge-detected output) BEFORE fixing — each axis owns its detector, fix leg, verifier; the routing protocol now lives in the piflow-fixer skill, this card retains its grounding evidence.
- [Route every defect to a SIDE, not just a place](cards/four-way-triage.md) — Triaging a post-run defect before editing anything — bucket it LAPSE→SKILL→FUNCTIONALITY→ARCH top-down, default to LAPSE when unsure.
- [Control invariants for autonomous improvement loops](cards/loop-control-invariants.md) — Building/reviewing a self-editing optimize loop — bound it with caps, condition early-stop, a breaker, and delta memory, not just a round count.
- [The across-run accept gate — candidate copy, held-out score, strict improvement](cards/outcome-gated-accept.md) — Use before any self-editing loop auto-lands a change — gate on a held-out score with strict improvement, never let round count alone be the safety.
- [Spend budget on parallel candidates, not longer single attempts](cards/parallel-variants-over-longer-thinking.md) — When a fixer/producer is stuck or a result is marginal, fan out diverse parallel attempts and select — don't push one attempt deeper.
- [Frozen inputs and N-discipline — what a run comparison may honestly claim](cards/run-variance-discipline.md) — Before comparing runs or claiming an improvement — freeze every upstream input, know the variance band, and match the claim type to N (mechanism N=1, levels N≥3).

## execution
- [Grow large artifacts one element per edit — conditioned, with a skeleton for global coherence](cards/grow-the-artifact.md) — A node authors a large structured artifact (15+ interdependent elements) or its trace shows whole-artifact composition — grow it one element per edit, skeleton-first; small strong-prior artifacts stay single-pass.
- [Issue calculators from the trace — an answering service, never a judge](cards/model-callable-calculators.md) — A node hand-derives computable quantities in its thinking (sqrt/ratio text, re-derived report numbers) — issue an answering-service calculator, never a judge.
- [The deepest tier is not the best fixer — route by job, verify by edits landed](cards/fixer-model-tiering.md) — Reach for this when picking/auditing a fixer's model tier, or a deep-tier fixer diagnoses well but never commits an edit.
- [Overthinking is a quality defect; caps work but verify the lever binds](cards/overthinking-and-thinking-caps.md) — Reach for this when setting/reviewing a thinking-length cap or effort knob — confirm it moves measured thinking volume before crediting it for any result.
- [Bounded retries, one variable changed, exhaust the ladder before giving up](cards/retry-escalation-ladder.md) — A failure gets retried blindly/identically, or an agent settles/escalates too soon — classify first, bound retries, change one variable, exhaust the ladder.
- [Tool thrash predicts failure; tripwire it, do not tolerate it](cards/tool-call-efficiency.md) — Reach for this when a run repeats calls, burns calls with zero progress, or over-searches — wire deterministic tripwires; don't rely on judgment to notice.
- [A deterministic gate must parse what the system teaches, fail closed on garbage parses, and state its own measurement](cards/fail-closed-deterministic-gates.md) — Use when a gate/linter flags artifacts the producer believes correct, repairs don't converge (identical-args tool loops), or a sentinel check can match prose mentions.

## context
- [Compose context just-in-time; length alone degrades quality](cards/context-composition.md) — Reach for this when a prompt/context is growing to "be safe," a critic shares the producer's history, or context% is climbing — before the window is full.

## knowledge
- [Every kind of knowledge has ONE home — process in the skill, field contract in the template, craft in the variant module](cards/layered-instruction-homes.md) — Use when a shared skill/prompt accumulates variant-specific rules, field-emission guidance, or failure vignettes — re-home each kind (process/contract/craft/failures) and gate with a zero-mention census.
- [How this library stays honest — track record in, diaries out](cards/library-maintenance.md) — Adding/editing/applying a card in this library — apply the same defect loop the library teaches to itself.
- [Lessons are short current-truth blocks; history lives in git](cards/memory-recording-policy.md) — A lesson/memory file is turning into a hand-appended diary, growing unbounded, or its git-tag pointer convention is unenforced.
- [Building a skill corpus that agents can find, trust, and safely evolve](cards/skill-system-construction.md) — Reach for this when authoring/splitting a skill, writing its description, wiring cross-refs, or editing corpus prose after a failure.
- [Three knowledge stores, one join law — pointer + resolve-at-read](cards/three-knowledge-legs.md) — Deciding where a lesson, a code map, or a practice belongs, and how cross-leg refs stay fresh — split by freshness gate, join by pointer, never copy.

## supervision
- [Supervise as an event-woken sentinel enforcing a standing policy](cards/supervision-and-wake-policies.md) — A human keeps babysitting a stream or re-judging runs by hand — replace it with an event-woken sentinel enforcing one written policy.
