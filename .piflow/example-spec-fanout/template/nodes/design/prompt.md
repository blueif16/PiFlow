Read the request under {{RUN}} and FREEZE one spec to `spec/blueprint.json` — the single frozen contract every producer fills.

`blueprint.json` MUST enumerate, per facet (types · impl · tests), the exact fragment each producer owns: its file path under `frag/<facet>/`, the interface it must satisfy, and how the facets fit together into one module. Once written it is immutable — producers read it, never re-negotiate it. Keep it strict, complete, and disjoint across facets.
