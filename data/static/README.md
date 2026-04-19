# Static EPA reference data

These files are checked into the repo and consulted **offline** by the EPA enrichment build script (`scripts/build-epa-cache.ts`). None of them require an API key.

## Files

### `rcra_codes.json`
Hand-curated subset of the RCRA F-list, P-list, and U-list from 40 CFR § 261 Subpart D. Each `by_cas` entry maps a CAS number to its waste code(s), human-readable name, and which list it lives on. `by_name` provides a few common-name aliases for reagents that don't always come into the pipeline with a CAS attached.

The `spent_solvent_lists` block (F001–F005) is reference text only — those codes are assigned at the *waste-stream* level by the deterministic engine, not by per-reagent lookup, since they only apply to spent solvents.

To extend it: add entries from https://www.ecfr.gov/current/title-40/chapter-I/subchapter-I/part-261/subpart-D as new reagents land in `data/seed/reagent_term_map.csv`. Keep the `last_reviewed` date in `_meta` honest.

### TRI chemical list — lives in `data/tri_chemicals/`

Not in this folder — TRI lives one level up at `data/tri_chemicals/`. Drop one or more `.csv` files there; the loader merges every CSV in the directory.

1. Go to **https://www.epa.gov/toxics-release-inventory-tri-program/tri-listed-chemicals**.
2. Download the latest reporting-year XLSX (currently RY2025).
3. Convert each sheet to CSV (the EPA file has two sheets — main list + supplemental). Both should land in `data/tri_chemicals/`.
4. The loader tolerates the `CASRN` / `CAS` / `CAS Number` and `Chemical Name` / `Name` column variants EPA has used over the years.

If the directory is missing or empty, the build script skips TRI lookups and everything else still works.
