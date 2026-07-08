---
key: run-variance-discipline
title: Frozen inputs and N-discipline — what a run comparison may honestly claim
domain: loops
status: candidate
description: Before comparing runs or claiming an improvement — freeze every upstream input, know the variance band, and match the claim type to N (mechanism N=1, levels N≥3).
aliases: [frozen input, fixed input rerun, A/B discipline, replicate, variance band, N of 1, confounded run, rerun protocol]
tags: [experiments, variance, verification, reruns, claims]
updated: 2026-07-07
---

# Frozen inputs and N-discipline — what a run comparison may honestly claim

## Trigger
- A rerun's result is about to be COMPARED to another run (A/B arm, fix verification, replicate batch).
- Someone is about to claim a change improved (or regressed) wall-clock, cost, or a quality score.
- An upstream node re-ran fresh inside a comparison arm, or two "same-config" runs differ more than expected.

## Practice
1. **Freeze upstream before any comparative rerun.** Hold every input to the node-under-test fixed: reuse the
   baseline run's upstream artifacts and run state, and start the run AT the node under test (a resume/window
   mechanism, not a fresh top-of-DAG run). Verify the harness reports the upstream node as REUSED, not re-run.
   An upstream producer re-run fresh varies its prose output — that variance is a treatment you didn't intend.
2. **One variable per arm.** The diff between two compared runs must be exactly the change under test
   (template edit, model swap, config flag). If two things changed, the comparison identifies neither.
3. **Match the claim to N.** Binary mechanism signals (a tool fired, a menu was read, a mark flipped
   PASS/FAIL for a named reason) are honest at N=1. LEVEL claims — wall-clock, cost, judged score — need N≥3
   frozen-input replicates, judged/measured identically, before any "improved/declined" statement.
4. **Know the band before interpreting a delta.** Establish the metric's spread from history (re-measure old
   runs with the current instrument/judge if needed); a delta inside the band is a draw, not a signal.
4b. **Prefer count-based metrics over wall-clock for the agentic front.** Tokens in/out, thinking chars, and
   call counts are provider-rate-independent; wall-clock confounds model behavior with the provider's shifting
   generation rate and is the noisiest level metric — report it last, never lead with it.
5. **Same judge, same calibration.** Quality comparisons must be scored by the same judge context/rubric,
   blind to provenance; re-judging history with the current judge beats trusting old scores.
6. **Kill confounded arms.** A comparison run discovered mid-flight to have varied inputs is not partial
   evidence — it is noise with a record; stop it and relaunch frozen.

## Evidence
- Two same-prompt upstream (classifier) runs wrote materially different `mustPreserve` framings; one steered
  the producer to the exact stock design that failed the creativity mark → game-omni wa8 vs wa9 w0 diff, 2026-07-07.
- Judged quality of six same-prompt, near-same-config runs spanned 4→9 /10 (blind re-judge, one judge, one
  calibration) → game-omni wa1–wa6, 2026-07-06; an N=1 score move is indistinguishable from this spread.
- Wall-clock band ≈ ±180s on one model tier: 441s vs 552s vs a 730–740s cluster across mechanism-identical
  arms → game-omni wa3/wa4–6/wa8.
- First correct application: a confounded arm (fresh upstream) killed mid-run, relaunched with frozen
  upstream showing `reused` — only then is the template change the sole variable → wa10 killed / wa11, 2026-07-07.

## Anti-patterns
- Running the full DAG fresh for an A/B of one node "because that's how the last run was launched."
- Celebrating an N=1 score/wall-clock delta the same day the variance band was measured wider than the delta.
- Comparing runs scored by different judges/calibrations, or a fresh judge against remembered old scores.
- Keeping a confounded arm's numbers "since it already ran."

## Applications
- 2026-07-07 · game-omni w1-design · wa10 (fresh-w0 arm) killed mid-run; wa11 relaunched on wa9's frozen
  classification+state (`w0-classify: reused`) — cluster-fix became the sole variable · piflow-start skill
  now carries the rule in its run contract.

## See also
[[agentic-vs-quality-routing]] · [[judge-reliability]] · [[outcome-gated-accept]]
