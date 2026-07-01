Read every fragment under `frag/` against the frozen `spec/blueprint.json` and RETURN a PASS/FAIL verdict — this is the join gate before build.

Check each facet fragment (types · impl · tests) exists, honors the interface the spec froze, and composes with the others (no gap, no overlap, no drift from the frozen contract). Return `required` mode: PASS only if all fragments cohere into one buildable module; FAIL with the specific facet + mismatch otherwise.
