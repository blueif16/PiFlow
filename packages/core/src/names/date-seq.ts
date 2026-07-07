// ─────────────────────────────────────────────────────────────────────────────
// generateDateSeqName — M1's SCALABLE default run identity: `YYMMDD-NN` (e.g. "260706-01", "260706-02",
// …), a zero-padded PER-DAY counter. Replaces the Docker-style `<adjective>-<pie>` name (generator.ts) as
// `piflowctl run`'s DEFAULT auto-mint — agent-driven runs need a name space that scales to hundreds of
// runs a day and sorts/scans cleanly, which a random `<adjective>-<pie>` pick does not. `generateRunName`
// stays exported/usable; its word-space is reassigned to ISSUE naming (optimize/substrate, M2).
//
// SAME `(existing, …) ⇒ string` collision contract as `generateRunName`: `existing` is every run-name
// basename already in use (the CLI's `listExistingRunNames`), and the counter is SCANNED against it (a
// sparse `existing` — e.g. a deleted middle run — is gap-filled, never blindly maxed), so it NEVER returns
// a name already taken. `now` is injected (default `new Date()`) so a test asserts exact day/formatting
// without touching the wall clock. Dates are read in UTC — hermetic across the machine's local timezone.
//
// A base name minted here is DOT-FREE by construction (`YYMMDD-NN` has none) — dots are reserved for
// child-run LINEAGE (`childRunName`, ./child.ts), never a top-level run's own identity.
// ─────────────────────────────────────────────────────────────────────────────

/** `YYMMDD` (UTC) for `now` — the day prefix `generateDateSeqName` counts against. */
function yymmdd(now: Date): string {
  const yy = String(now.getUTCFullYear() % 100).padStart(2, '0');
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

/**
 * Mint a `YYMMDD-NN` run name NOT present in `existing`, for the UTC day of `now`. Scans `n` from 1,
 * zero-padded to (at least) 2 digits, skipping any value already taken — so a sparse `existing` set is
 * gap-filled rather than jumped past (deleting the day's `-02` run makes the NEXT mint `-02` again, not
 * `-04`). A different day's names never collide (the `YYMMDD` prefix differs) — the counter resets to
 * `-01` at day rollover.
 *
 * @param existing run names already in use (e.g. the run-dir basenames under the canonical runs home).
 * @param now      the clock to mint against — default `new Date()`; a test injects a fixed instant.
 */
export function generateDateSeqName(existing: Iterable<string> = [], now: Date = new Date()): string {
  const taken = new Set(existing);
  const day = yymmdd(now);
  let n = 1;
  let name = `${day}-${String(n).padStart(2, '0')}`;
  while (taken.has(name)) {
    n++;
    name = `${day}-${String(n).padStart(2, '0')}`;
  }
  return name;
}
