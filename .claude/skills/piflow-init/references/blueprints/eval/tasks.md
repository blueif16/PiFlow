# Compose-eval tasks (the COMPOSE agent sees ONLY this file + the authoring layer)

Each task is a real workflow NEED. Reason it into a DAG, pick the matching blueprint shape(s) from the catalog,
size the holes, and stamp an `extract`-green template into the given scratch dir. Write each `prompt.md`
task-only. Do NOT read `reference.md`.

---

## T1 — outreach workflow design
I want to stand up a cold-outreach workflow, but I don't know the current best practices, and they span a few
independent areas: email deliverability/warmup, lead enrichment/contact-data, and campaign analytics. Go learn
each area to a decision-grade bar, reconcile what you learn into one design, and produce the workflow template
that design implies. Stamp into `<scratch>/t1`.

## T2 — self-correcting config build
Generate a deployment config file from a written spec. It has to be exactly right, so after generating it, gate
it against the spec's validation rules, and if it fails, fix and re-gate — loop until it passes (bounded).
There is one deliverable. Stamp into `<scratch>/t2`.

## T3 — independent review panel → consensus
I have a design doc I want assessed. Get several INDEPENDENT reviewers to each judge it against a shared rubric
(no reviewer should see another's take), then reconcile their verdicts into one consensus decision with the
blocking issues. Stamp into `<scratch>/t3`.

## T4 — spec then build the parts in parallel
Design a small service: first lock one spec, then build its separate parts — the data types, the request
handlers, and the tests — at the same time (they're different files, no overlap), then check they cohere against
the spec, then assemble the finished module. Stamp into `<scratch>/t4`.

## T5 — panel-drafted, hardened explainer
Write a technical explainer. I don't trust a single model's draft, so draft it with a small PANEL of models for
coverage and have a judge merge them; then harden that draft by sampling it several times and keeping/repairing
the strongest; then publish the final. Stamp into `<scratch>/t5`.

## T6 — implement-and-fix a function (the falsifier task)
Implement a single function to a spec, run its test, and if the test fails, debug and fix it, re-running the
test each time until it's green (bounded attempts). One function, one test, a sequential fix loop. Stamp into
`<scratch>/t6`.
