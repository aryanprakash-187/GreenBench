# scripts

Build-time and one-off scripts. Run via npm scripts defined in the root `package.json`.

## `build-epa-cache.ts` — EPA enrichment pipeline

Reads `data/seed/reagent_term_map.csv`, looks each reagent up against the three EPA sources (CompTox CCTE API, TRI listed-chemicals CSV, RCRA F/P/U-list JSON), and writes the merged result to `data/epa_cache.json`.

### Usage

```bash
# Full build (auto: CompTox if key configured, otherwise PubChem)
npm run epa:build

# Show what would happen, don't write the cache
npm run epa:build -- --dry-run

# Process only a subset of reagents (matches against epa_lookup_key)
npm run epa:build -- --only=alcohol_liquid_waste,DMSO_liquid_waste

# Force a specific hazard source
npm run epa:build -- --source=pubchem    # NIH PubChem (no key, free)
npm run epa:build -- --source=comptox    # EPA CompTox CCTE (requires key)
npm run epa:build -- --source=none       # RCRA + TRI only, no GHS lookups
```

### Hazard source: CompTox vs PubChem

The `hazard` block of each cache entry can be filled by either of two interchangeable sources:

- **CompTox CCTE** (preferred when available) — EPA-published, requires an API key obtained via email to `ccte_api@epa.gov`. Turnaround 1–3 business days.
- **PubChem** (default fallback) — NIH public database, no key, works immediately. Aggregates the same GHS classifications from ECHA / OSHA / vendor SDSs that CompTox draws from. Misses CompTox-only fields like quantitative ToxValDB endpoints.

The cache records which source was used in `entry.summary.hazard_source` and `entry.hazard.source`. Engine and UI code should never branch on which one — both populate `ghs_codes`, `ghs_phrases`, and `hazard_categories` the same way.

### Required env

`EPA_CCTE_API_KEY` — only needed if you want to force `--source=comptox`. With `--source=auto` (the default) the script runs without it.

### Inputs

- `data/seed/reagent_term_map.csv` — reagent normalization map (Data lead owns this).
- `data/static/rcra_codes.json` — curated F/P/U-list, committed.
- `data/static/tri_chemicals.csv` — TRI Chemical List, **download separately** (see `data/static/README.md`). If absent, TRI is skipped.

### Output

- `data/epa_cache.json` — read by the deterministic engine and the recommendation cards in the UI.

### When to re-run

- The reagent map changes (new reagent rows).
- You just got your CCTE API key and want to backfill the CompTox blocks.
- A teammate updated `rcra_codes.json` or downloaded a fresher TRI CSV.

The cache is **fully regenerated** on every run — no incremental state to worry about.
