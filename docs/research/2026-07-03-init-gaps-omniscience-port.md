# Init gaps — findings from standing up Omniscience (lesson + quiz workflows)

Date: 2026-07-03. Source: initializing two real workflows in the Omniscience repo (kids-education
product; Next.js + Python LangGraph backend) — a PORT (`.claude/workflows/section-adventure.js` →
`.piflow/section-adventure/template/`, 14 nodes) and a COMPOSE (`.piflow/quiz/template/`, 12 nodes,
scaffold loop). Every item below was hit for real; none is speculative.

## PORT-path gaps (parse-claude-workflow.mjs → template)

1. **The port emits a spec.json, not a template.** `parse-claude-workflow.mjs` ends at a compiled
   `WorkflowSpec`; the template (meta.json + nodes/<id>/{node.json,prompt.md}) had to be assembled by a
   hand-written one-off converter. Gap: a `piflowctl port <workflow.js> [--arg k=v …] -o <templateDir>`
   verb (or a `--template` flag on the script) that emits the template directly — node-id normalization,
   prompt.md + node.json emission, meta.json with phases.
2. **De-realization is fully manual.** The extractor KNOWS the args it realized the run with
   (`--arg bookId=1`) yet the emitted prompts/paths carry the realized literals. It could auto-replace
   realized arg values with `{{arg.<k>}}` tokens (longest-match first; warn on ambiguous short values
   like `1`). Dynamic per-run values (the slug a resolve node returns) need `{{state.*}}` + a promote —
   auto-detecting is hard, but the port could at least FLAG recurring non-arg literals shared across
   many node prompts as promote candidates. (The slug appeared in 13/14 nodes.)
3. **`agent()` schema is dropped.** The source workflow's per-node `schema` (the structured-return
   contract) is not carried into the spec; the template has a first-class `return` field it could map to.
   Today the RECORD prose is the only remnant of the return shape.
4. **`phase()` tags are dropped per node.** Recorded nodes came out `phase: undefined`; phases had to be
   re-derived by hand — yet profiles elide BY phase, so this is the port's direct input to profile
   authoring. Carry the recorded phase per node.
5. **Claude agentType leaks through.** The recorded `agentType: "general-purpose"` is Claude-runtime
   vocabulary, not a piflow preset — emitting it verbatim would make the loader reject/mismatch. The
   port should map known Claude types (drop `general-purpose`, warn on others).
6. **The globally-installed skill copy of the script is dead.** `REPO_ROOT` resolves 4-dirs-up from the
   script's own location, so the `~/.claude/skills/piflow-init/scripts/` copy can't find
   `templates/pi-runner/extract.mjs` / `packages/core/dist`. Resolve the piflow root robustly (env var /
   ~/.piflow config) or document "run the repo copy" in the skill.

## Scaffold-loop gaps (piflowctl new / add-node)

7. **`contract.execCwd` is not flag-scaffoldable.** It's in node.schema.ts (E10) but `add-node` has no
   `--exec-cwd` — violating the "buildNode mirrors node.schema.ts" anti-drift rule. Needed on ALL 26
   nodes here (repo-rooted product convention: the bridge writes CWD-relative `.artifacts/…`); patched
   into node.json by script.
8. **`--read` REPLACES the default `{{RUN}}` instead of adding to it.** `add-node --read '{{WORKSPACE}}'`
   emitted `readScope: ["{{WORKSPACE}}"]` with no `{{RUN}}` — surprising, and it silently jails a node
   out of its own run dir (where its ledger lives). Either always keep `{{RUN}}` or make the doc explicit.
9. **Profiles are not scaffoldable.** `profiles`/`defaultProfile` in meta.json were hand-edited both
   times. A `piflowctl new --profile 'name:elidePhases=a,b' --default-profile name` (repeatable) closes it.
10. **`--help` crashes `new`/`add-node`** (`flag --help needs a value`). `piflowctl schema` covers the
    reference need, but the crash is hostile to first contact.

## Run-path gap

11. **No token for the auto-minted run id.** `{{arg.run}}` resolves only when `--run <id>` is passed
    explicitly (run.ts mirrors it into args only then); an auto-generated id is unreachable from
    templates. Worked around by moving the per-node ledger to `{{RUN}}/ledger/` — arguably the BETTER
    pattern (the run dir IS per-run) — but either mirror the generated id into args uniformly or
    document the run-rooted-ledger idiom in the port reference.

## What worked 1:1 (keep and name these patterns)

- **Profiles = the source workflow's MODE axis.** companion/production mapped to `elidePhases` exactly;
  the elision predicate rewired deps correctly in all six profile shapes (lesson 9/6/14 nodes, quiz
  7/4/12). Later re-cut per user posture: `default` (no debug/fix — improvement rides the out-of-band
  optimizer on the producing node), `optimize` (producers only), `full`.
- **Checkpoint = the human approval gate.** The quiz teacher-approval (prod: run-ends → re-invoke with
  `plan_status="approved"`) mapped to one `--checkpoint confirm` node.
- **The persona-bridge CLI is THE enabler for porting a prod graph.** Omniscience's
  `section_adventure_dev.py` (assembles byte-identical prod personas incl. the component registry;
  hosts the deterministic gate) is what makes thin piflow nodes possible — the registry reaches the
  planner "for free" through `planner-context` (live-verified: 178KB persona, 45 props_contract blocks).
  The quiz flow had NO such bridge, so init had to grow one (`quiz_dev.py`, same shape). piflow-init
  should name this pattern explicitly: "if the product has a prod graph, wrap its prompt assembly in a
  per-node CLI the nodes shell — never re-derive personas in prompt.md."
- **`{{WORKSPACE}}`-rooted artifacts + `execCwd` carried a repo-rooted product convention** without
  touching the product's own path logic.
