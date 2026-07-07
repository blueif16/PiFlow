# Issue-Ledger Schema — State of the Art (2026-07-05)

Research brief for a per-node "optimization substrate": after a node runs, hard
programmatic checks + a soft LLM judge emit INDEPENDENT issues (smallest units
of optimization), recorded in a stable per-node JSON ledger, tracked for
recurrence across runs, activated one-by-one via a knob, released to a fix
agent, optionally proven by re-running the node, and eventually linked to the
commit that landed the fix. This brief surveys five bodies of prior art and
ends with a recommended field schema.

---

## 1. Static-analysis finding schemas (SARIF, CodeQL, Semgrep)

**Findings.** SARIF (OASIS-standardized, current version 2.1.0 + Errata 01) is
the closest thing to a cross-industry standard for "a programmatic check emits
a finding." Its `result` object carries: `ruleId` (which detector fired),
`level` (`error`/`warning`/`note` — the tool's own significance, not a business
severity), `locations[]` (each a `physicalLocation` with `artifactLocation.uri`
+ a `region` of start/end line/column), `fingerprints` (stable hashes meant to
survive across runs) and `partialFingerprints` (weaker/supplementary hashes,
e.g. `primaryLocationLineHash`), plus `baselineState` — an enum of
`new`/`unchanged`/`updated`/`absent` computed by diffing a run against a
baseline (GitHub/Azure DevOps auto-compute this; `absent` = present in the
baseline but not found now, i.e. plausibly fixed). GitHub's own code-scanning
SARIF ingestion is explicit that fingerprint stability depends on the `ruleId`
staying the same and the file path staying consistent across analyses.

Semgrep's JSON output (schema of record: `semgrep/semgrep-interfaces`) is a
second, independently-converged design: each result has `check_id`, `path`,
`start`/`end` (line/col/offset), and an `extra` object holding `message`,
`severity` (`INFO`/`WARNING`/`ERROR`), and a free-form `metadata` bag. Critically,
Semgrep's own best-practice guidance recommends putting `confidence`
(`high`/`medium`/`low` — rule-accuracy, not business impact) *inside* metadata
as a field distinct from `severity`, alongside `cwe`, `category`, `owasp`,
`likelihood`, `impact`, and `references`. Semgrep also emits `extra.fingerprint`
and (since 1.14.0) `extra.hashes` for identity, and `extra.fixed_lines` /
`is_blocking` for a mechanical-fix hint.

**Sources.**
- [SARIF v2.1.0 Plus Errata 01 (OASIS)](https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html)
- [SARIF support for code scanning (GitHub Docs)](https://docs.github.com/en/code-security/code-scanning/integrating-with-code-scanning/sarif-support-for-code-scanning)
- [JSON and SARIF fields (Semgrep Docs)](https://semgrep.dev/docs/semgrep-appsec-platform/json-and-sarif)
- [semgrep-interfaces / semgrep_output_v1.jsonschema (GitHub)](https://github.com/semgrep/semgrep-interfaces/blob/main/semgrep_output_v1.jsonschema)

**BORROW.** A stable rule/check identifier separate from the finding instance
(`ruleId`/`check_id`); a `locations[]`-style pointer at file+region (or, for
us, node/skill/tool span); an auto-computed `baselineState`-like transition
(`new`/`unchanged`/`absent`) derived by diffing result sets across runs rather
than hand-maintained; Semgrep's split of `severity` (business/rule significance)
from `confidence` (detector accuracy) as two orthogonal fields.

**AVOID.** SARIF's `level` field is frequently conflated with severity in
practice even though the spec means it as tool-significance — keep our
severity scale independent of any detector's internal level. Don't let
`baselineState`/`absent` alone stand in for "fixed" — see Theme 3 for why
that's an anti-pattern for us specifically.

---

## 2. Issue identity + dedup across runs

**Findings.** Sentry computes an event *fingerprint* per platform-specific
rules — for stack traces, each frame contributes module name, function name,
and a *context line* (source text of the failing line, trimmed of leading/
trailing whitespace) — deliberately not the full raw source, and deliberately
including semantic identifiers (module+function) rather than raw line numbers,
because "a function can often fail from different branches." Sentry lets
teams override the default via **Fingerprint Rules** using variables like
`{{ default }}`, `{{ error.type }}`, `{{ transaction }}`. Crucially: every time
Sentry's default grouping algorithm changes, it ships as a **new algorithm
version that only applies to new events going forward** — existing issues are
never silently rehashed.

SARIF's normative Appendix B ("Use of fingerprints by result management
systems") is the spec-level analogue: fingerprints should be stable across
executions, and consistency requires the `ruleId` and the file path to stay
the same between runs. Community discussion around the spec (`oasis-tcs/
sarif-spec` issues #122, #164, #374) shows the failure mode in practice: naive
line-hash fingerprints break the moment an unrelated edit shifts line numbers,
or a resource is renamed (container/package) — the old finding is wrongly
marked `absent` (fixed) while an identical new one is wrongly marked `new`.
An independent critique (BoostSecurity) confirms this is a live limitation of
SARIF-based tooling, not a solved problem.

**Sources.**
- [Sentry: Issue Grouping](https://docs.sentry.io/concepts/data-management/event-grouping/)
- [Sentry: Fingerprint Rules](https://docs.sentry.io/concepts/data-management/event-grouping/fingerprint-rules/)
- [oasis-tcs/sarif-spec issue #164 — fuzzy partial fingerprint matching & versioning](https://github.com/oasis-tcs/sarif-spec/issues/164)
- [oasis-tcs/sarif-spec issue #374 — loosen restrictions on RMS usage of partialFingerprints](https://github.com/oasis-tcs/sarif-spec/issues/374)
- [SARIF Limitations in Security Tooling & File Formats (BoostSecurity)](https://boostsecurity.io/blog/sarif-cant-save-you-now)

**What goes INTO a good hash:** the rule/detector id, a *structural* location
(module+function/node+skill-or-tool name — not a raw byte offset), and a
salient, *normalized* content signature (trimmed/whitespace-stripped source
text, or — per Theme 5's CLEAR pattern — an LLM-normalized one-sentence
paraphrase of the finding, not the judge's raw prose, since two runs will
phrase the same issue differently).

**What must NOT go in:** timestamps, invocation/run IDs, absolute/sandbox-
specific file paths, raw line/column numbers used alone (they drift whenever
unrelated code above them changes), and machine/host identifiers.

**BORROW.** Sentry's versioned-algorithm discipline — never retroactively
rehash existing issues when the identity recipe changes, only apply the new
recipe going forward — protects recurrence history. SARIF's two-tier design
(a stronger `fingerprints` plus weaker `partialFingerprints`) gives graceful
degradation when the strong hash misses.

**AVOID.** Pure line-number hashing as the *only* signal (breaks on any
unrelated diff); silently rehashing/renumbering existing issue IDs on a
recipe change (destroys cross-run recurrence tracking, which is a stated
requirement).

---

## 3. Issue lifecycle / status models

**Findings.** GitHub code-scanning alerts have a genuinely minimal state set:
`open` → `dismissed` (with a required `dismissed_reason` of `false positive`,
`won't fix`, or `used in tests`, plus an optional `dismissed_comment`) →
or `fixed` (auto-closed the moment the tool stops re-detecting the same
fingerprint). Dismissed alerts can be reopened. Notably, `fixed` is **inferred
from absence**, not asserted by anyone — GitHub added a `fixed_at` timestamp to
the alert API precisely so consumers could tell *when* a fingerprint stopped
recurring, but there is no field recording *which* commit or PR did it. A
GitHub community discussion explicitly flags this gap: none of the three
dismissal reasons "really reflect that the issue was in fact fixed," since
fixed and dismissed are handled as separate, disjoint paths.

Jira's ecosystem-wide convention (per Atlassian docs + practitioner consensus)
converges on keeping the *status* dimension minimal — three categories
(`Todo`/`In Progress`/`Done`), commonly implemented as just three or four
literal statuses — and pushing the *why* into a separate **Resolution**
field (`Fixed`, `Won't Fix`, `Duplicate`, etc.) set only at the terminal
transition. The repeated practitioner advice is: don't multiply terminal
statuses to capture nuance; add a side field instead.

**Sources.**
- [About code scanning alerts (GitHub Docs)](https://docs.github.com/en/code-security/code-scanning/managing-code-scanning-alerts/about-code-scanning-alerts)
- [Resolving code scanning alerts (GitHub Docs)](https://docs.github.com/en/code-security/how-tos/manage-security-alerts/manage-code-scanning-alerts/resolve-alerts)
- [What are work item statuses, priorities, and resolutions? (Atlassian Support)](https://support.atlassian.com/jira-cloud-administration/docs/what-are-issue-statuses-priorities-and-resolutions/)
- ["Closed" or "dismissed"? (github/codeql-action #373)](https://github.com/github/codeql-action/issues/373)

**BORROW.** Separate the *state* (where in the pipeline) from the *reason*
(why it left that state) exactly as Jira's Resolution field and GitHub's
`dismissed_reason` do — one status axis, one free reason/resolution axis.
Auto re-open on re-detection (GitHub reopens a dismissed alert if its
fingerprint reappears) is a good model for what "prove by re-running" should
do on a regression.

**AVOID.** Don't proliferate terminal statuses (the Jira anti-pattern). More
importantly for us: don't copy GitHub's absence-based `fixed` as the *only*
proof mechanism — for an agent-driven fixer, an issue's fingerprint can
disappear because the code path was deleted, refactored around, or simply
went untested in the next run, not because it was actually fixed. Our
lifecycle needs an explicit, positive **verification** state (targeted
re-run proving the specific issue no longer reproduces), not silent
disappearance — this is the smallest honest addition GitHub's own model
is missing.

**Recommended minimal state set:** `open` → `active` (selected by the
one-by-one knob) → `fix-proposed` → `fix-landed` → `verifying` →
`resolved` | `regressed` (back to `open`), with a side-channel `reason` field
(`fixed`/`wontfix`/`false-positive`/`superseded`) set only at a terminal
transition — mirroring Jira's status/resolution split and GitHub's
state/dismissed_reason split, but adding the explicit `verifying` step GitHub
lacks.

---

## 4. Linking issues to fixes/commits

**Findings.** GitHub's issue↔commit linkage is a text convention: a commit
message or PR body containing `Fixes #45` / `Closes #45` / `Resolves #45`
auto-closes issue #45 once merged to the default branch (cross-repo via
`owner/repo#45`). This is fragile in two documented ways: (1) it only fires
on merge to the *default* branch, so long-running/maintenance-branch fixes
don't trigger it; (2) the community has explicitly called the "one merged PR
mentions this issue ⇒ issue is fixed" inference "naive... and indeed
dangerous," leading some teams to deliberately avoid the magic keywords and
GitHub to add a repo-level opt-out for auto-close-on-merge.

Separately, GitHub's code-scanning alert API added a `fixed_at` timestamp
(2021-12-10 API changelog) — but this is *only* a timestamp of last-non-
detection; there is no structured field on the alert recording the specific
commit SHA or PR number that fixed it. Even GitHub's flagship system, in
other words, treats "resolved" as an absence-plus-timestamp fact, not a
stored provenance edge from finding to fix.

**Sources.**
- [Closing issues using keywords (GitHub Docs)](https://docs.github.com/en/enterprise/2.16/user/github/managing-your-work-on-github/closing-issues-using-keywords)
- [Closing Issues via Pull Requests (GitHub Blog, origin of the feature)](https://github.com/blog/1506-closing-issues-via-pull-requests)
- [Prevent issues from being closed by merging linked PRs (github/community #17308)](https://github.com/orgs/community/discussions/17308)
- [Improvements to the code scanning API (`fixed_at`) (GitHub Changelog)](https://github.blog/changelog/2021-12-10-improvements-to-the-code-scanning-api/)

**BORROW.** Keep the human-facing commit-trailer convention (`Fixes #<id>`)
as a *presentation* surface — it's what makes the ledger legible in `git log`
— but do not stop there.

**AVOID.** Do not rely solely on "a merged commit/PR mentioned this issue" as
proof of fix (the community has explicitly flagged this as unsound), and do
not rely solely on absence + timestamp as GitHub's alert API does. Given
GitHub's own gap here, our ledger should record structured provenance
ourselves rather than lean on VCS text conventions: `fixedByCommit` (SHA),
`fixedByRun`/PR reference, and a distinct `verifiedByRunId` — the run that
re-executed the node and *positively* observed the issue no longer
reproduces (see Theme 3's `verifying` state).

---

## 5. Agent-optimization prior art for decomposed issue records

**Findings.**

- **TRAIL** (arXiv:2505.08638, Deshpande et al.) formalizes a taxonomy of
  20+ agentic error types (reasoning/planning/system-execution) and applies
  it to 148 human-annotated agent traces (1,987 OpenTelemetry spans, 575 with
  ≥1 error). Each annotated error carries: a **span id** (where in the trace),
  an **error category** (from the taxonomy), **supporting evidence**, a
  free-text **description**, and an **impact level** (Low/Medium/High). This
  is the most directly analogous prior art to "a programmatic/judge pass
  emits a located, categorized, evidenced finding at a specific point in an
  agent's execution" — precisely our per-node situation. Note the paper's own
  headline result: even the best LLM judge (Gemini-2.5-Pro) scores ~11–18%
  joint accuracy at localizing these errors — a caution against trusting a
  single LLM judge pass to self-certify its own findings.

- **CLEAR** (arXiv:2507.18392, Yehudai et al.) tackles a different but
  adjacent problem: turning many *instance-level* judge critiques into a
  *small set of system-level issues*. Its pipeline: normalize each raw
  critique into "a brief and well-formed sentence" via an LLM, cluster/
  summarize those normalized sentences, then (in the LLM-based variant)
  prompt an LLM over batches of summaries to identify recurring high-level
  issues and deduplicate/consolidate. Each resulting system-level issue
  record carries a **description/title**, a **frequency count**, a
  **prevalence percentage**, and **representative examples** linking back to
  the instances that exhibit it — and the method deliberately only
  clusters *negative*-feedback instances. This is essentially the
  recurrence-tracking mechanic we need, computed via clustering-on-normalized-
  text rather than exact-hash matching alone (so it also catches
  near-duplicate issues a naive hash would treat as distinct).

- **GEPA** (arXiv:2507.19457, Agrawal et al., ICLR 2026 oral) optimizes
  prompts/systems by feeding an LLM the full execution trace plus a
  `(score, feedback_text)` pair per evaluation, rather than a bare scalar
  reward — and critically, feedback can be attributed **per module/per hop**
  in a multi-step pipeline (directly analogous to per-node attribution),
  which the paper shows makes even a single reflective update yield large
  gains. Candidate selection uses a **Pareto frontier** across problem
  instances rather than chasing one global best score, avoiding local optima
  from over-fitting to a single aggregate metric.

- **LLM code-review bots** (CodeRabbit, Greptile — surveyed in an independent
  4-tool, 146-PR/679-finding study alongside Sentry Seer and Cursor BugBot)
  show production conventions for a machine-generated finding: a
  **severity** label, a **category** (critical bug / refactor / performance /
  validation / nitpick / false-positive), sometimes a **confidence score**
  (Greptile attaches one; CodeRabbit does not), and — when the fix is
  mechanical — an attached **diff/one-click suggested fix**. The same study's
  sharpest finding for us: severity vocabularies are inconsistent *across
  tools* (Seer's "high"/"critical" vs. Greptile's "P1" aren't directly
  comparable), which is exactly why a shared system needs one canonical
  severity scale rather than borrowing any single vendor's ad hoc one.

**Sources.**
- [TRAIL: Trace Reasoning and Agentic Issue Localization (arXiv:2505.08638)](https://arxiv.org/abs/2505.08638)
- [PatronusAI/TRAIL dataset (Hugging Face)](https://huggingface.co/datasets/PatronusAI/TRAIL)
- [CLEAR: Error Analysis via LLM-as-a-Judge Made Easy (arXiv:2507.18392)](https://arxiv.org/abs/2507.18392)
- [GEPA: Reflective Prompt Evolution Can Outperform Reinforcement Learning (arXiv:2507.19457)](https://arxiv.org/abs/2507.19457)
- [Best AI Code Reviewer in 2026? We Ran 4 in Parallel for 3 Weeks (146 PRs, 679 Findings) (DEV Community)](https://dev.to/_vjk/best-ai-code-reviewer-in-2026-we-ran-4-in-parallel-for-3-weeks-146-prs-679-findings-1c0f)

**BORROW.** TRAIL's `(category, evidence, impact)` triple per finding, scoped
to a specific execution span; CLEAR's frequency/prevalence recurrence signal
computed via normalized-text clustering rather than exact-hash-only matching
(catches paraphrase drift across judge runs); GEPA's insistence that
feedback be actionable natural-language text attributable to a specific
module — maps directly onto per-node scoping — plus its Pareto-style
"don't chase one aggregate score" discipline when deciding which issues to
activate; CodeRabbit/Greptile's practice of attaching a mechanical
diff/suggested-fix when the fixer can produce one cheaply, and treating
`confidence` as a field independent of `severity`.

**AVOID.** TRAIL and CLEAR are both offline benchmark/analysis harnesses over
a fixed trace corpus, not live per-issue lifecycle systems — borrow their
*record shape*, not their evaluation-harness framing. Don't trust a single
LLM-judge pass as ground truth for localization (TRAIL's own ~11–18% accuracy
result argues for hard programmatic checks wherever possible, LLM judgment
as a supplement). Don't invent an ad hoc severity scale per detector (the
4-tool study's explicit cross-vendor pain point) — fix one canonical scale
project-wide.

---

## Recommended schema

A per-node ledger entry (JSON), one object per independent issue:

```jsonc
{
  "id": "sha256:<hash>",              // stable identity, see hash recipe below
  "nodeId": "research",               // which node this issue belongs to
  "title": "…",                       // CLEAR-style normalized one-line summary
  "description": "…",                 // fuller free text (TRAIL "description")
  "category": "prompt|tool|product-code|architecture", // suspect-scope target
  "detector": {                       // TRAIL/SARIF: what produced this
    "kind": "hard-check|llm-judge",
    "ruleId": "…"                     // SARIF ruleId / semgrep check_id analogue
  },
  "severity": "critical|high|medium|low|info", // canonical scale (Theme 5 AVOID: don't borrow one vendor's ad hoc scale)
  "confidence": "high|medium|low",    // Semgrep/Greptile: orthogonal to severity
  "evidence": {                       // TRAIL "supporting evidence" + SARIF locations
    "spanId": "…",                    // trace/run span this was observed in
    "locations": [ { "path": "…", "region": "…" } ]
  },
  "impact": "low|medium|high",        // TRAIL impact level, distinct from severity's scale
  "status": "open|active|fix-proposed|fix-landed|verifying|resolved|regressed", // Theme 3
  "reason": null,                     // set only at terminal transition: fixed|wontfix|false-positive|superseded (Jira Resolution / GitHub dismissed_reason pattern)
  "fixConfig": {                      // per-issue fix knobs
    "activated": false,               // the one-by-one release knob
    "needsProof": true,               // Theme 3 AVOID: never trust absence alone
    "solutionVarieties": [ "…" ]       // candidate fix approaches (CodeRabbit/Greptile suggested-fix, GEPA proposed edits)
  },
  "recurrence": {                     // CLEAR frequency/prevalence pattern
    "count": 1,
    "firstSeenRun": "run-id",
    "lastSeenRun": "run-id",
    "seenInRuns": [ "run-id", "…" ]
  },
  "provenance": {                     // Theme 4: build this ourselves, GitHub doesn't
    "fixedByCommit": null,            // SHA, set on fix-landed
    "fixedByRef": null,               // PR/branch reference (Fixes #n convention surfaces here)
    "verifiedByRunId": null,          // the re-run that positively proved it (not mere absence)
    "verifiedAt": null
  },
  "createdAt": "…",
  "updatedAt": "…"
}
```

**Hash recipe (`id`).** `sha256(detector.ruleId + nodeId + normalizedLocation +
normalizedContentSignature)`, where `normalizedLocation` is a structural
anchor (function/skill/tool name — not a raw line number alone, per Theme 2)
and `normalizedContentSignature` is an LLM- or rule-normalized one-sentence
paraphrase of the finding (CLEAR's "brief, well-formed sentence" step),
**not** the judge's raw prose, so that two runs describing the same issue in
different words still hash identically.

**Explicitly EXCLUDED from the hash:** timestamps, run/invocation IDs,
absolute/sandbox-specific file paths, raw line/column numbers used alone, and
machine/host identifiers (Theme 2). When the hash recipe itself changes,
follow Sentry's versioning discipline: never retroactively rehash existing
ledger entries — only new findings use the new recipe, and old entries keep
their history.

---

## Condensed summary

**File:** `docs/research/2026-07-05-issue-ledger-schema-sota.md`

**Recommended schema (field: rationale):**
- `id` (hash of ruleId+nodeId+normalized location+normalized content, excl. timestamps/run-ids/raw-lines) — SARIF fingerprinting + Sentry grouping + CLEAR normalization, so identity survives rephrasing and irrelevant diffs.
- `category` (skill/prompt | tool | product-code | architecture) — matches the four issue targets specified in the task.
- `detector.kind` + `ruleId` — SARIF/Semgrep: know whether a hard check or an LLM judge produced it, and which rule.
- `severity` (critical/high/.../info) + `confidence` (high/med/low), kept separate — Semgrep + Greptile pattern; the 4-tool study shows conflating them is a cross-vendor pain point.
- `evidence.spanId`/`locations` + `impact` — TRAIL's (evidence, impact) fields for locating and grading a finding within a trace.
- `status` (open→active→fix-proposed→fix-landed→verifying→resolved/regressed) + separate `reason` — Jira status/resolution split + GitHub state/dismissed_reason split, plus an explicit `verifying` step GitHub's absence-based "fixed" lacks.
- `fixConfig.activated` (the one-by-one knob), `needsProof`, `solutionVarieties` — GEPA's per-module proposed edits + CodeRabbit/Greptile suggested fixes; `needsProof` exists because absence alone is not proof (Theme 3).
- `recurrence.{count, firstSeenRun, lastSeenRun, seenInRuns}` — CLEAR's frequency/prevalence-across-instances mechanic, generalized to across-runs.
- `provenance.{fixedByCommit, fixedByRef, verifiedByRunId, verifiedAt}` — built ourselves because GitHub's own `Fixes #n` + `fixed_at` timestamp model is documented as insufficient/naive for real proof.

**Five sharpest takeaways:**
1. Nobody — not even GitHub's flagship code-scanning system — stores a structured "this commit fixed this alert" edge; it only has a `fixed_at` timestamp and text-convention keywords the community itself calls "naive... and indeed dangerous" ([github/community #17308](https://github.com/orgs/community/discussions/17308), [GitHub Changelog](https://github.blog/changelog/2021-12-10-improvements-to-the-code-scanning-api/)). We must build explicit provenance + a positive `verifying` state ourselves.
2. Identity hashes must exclude timestamps/run-ids/raw-line-numbers and instead hash a normalized structural location + normalized content signature — SARIF's line-hash fingerprints are a documented, repeatedly-discussed failure mode when files are renamed or edited nearby ([oasis-tcs/sarif-spec #164](https://github.com/oasis-tcs/sarif-spec/issues/164), [BoostSecurity](https://boostsecurity.io/blog/sarif-cant-save-you-now)).
3. Never retroactively rehash existing issues when your identity recipe changes — Sentry ships grouping changes as new algorithm versions applied only prospectively ([Sentry grouping docs](https://docs.sentry.io/concepts/data-management/event-grouping/)), preserving recurrence history.
4. Keep status (pipeline stage) and reason (why it closed) as two separate fields, not one growing status enum — the converged practice across Jira and GitHub code-scanning alerts ([Atlassian](https://support.atlassian.com/jira-cloud-administration/docs/what-are-issue-statuses-priorities-and-resolutions/), [GitHub alert docs](https://docs.github.com/en/code-security/code-scanning/managing-code-scanning-alerts/about-code-scanning-alerts)).
5. Recurrence/dedup should cluster on normalized-text similarity, not just exact hash — CLEAR clusters normalized one-sentence paraphrases of judge critiques to catch near-duplicates a naive hash would split apart ([arXiv:2507.18392](https://arxiv.org/abs/2507.18392)); GEPA and TRAIL both confirm feedback should be attributable per-module/per-span, which is exactly our per-node granularity ([arXiv:2507.19457](https://arxiv.org/abs/2507.19457), [arXiv:2505.08638](https://arxiv.org/abs/2505.08638)).
