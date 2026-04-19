# Seed data

CSVs maintained by the Data lead. The current `reagent_term_map.csv` is a small **stub** so that the EPA enrichment script (`scripts/build-epa-cache.ts`) and the deterministic engine can be developed against a non-empty file.

When the real reagent map (covering all 30 seeded protocols) lands, it will replace this file. As long as the column headers match, no other code needs to change.

## Required columns for `reagent_term_map.csv`

Per the README's data-schema section:

| column | required | notes |
| --- | --- | --- |
| `raw_term` | yes | how the reagent appears in the vendor protocol |
| `normalized_name` | yes | canonical display name |
| `generic_overlap_group` | yes | cross-vendor functional class — what the engine matches on |
| `workflow_family` | yes | `dna_extraction` / `pcr` / `bead_cleanup` |
| `stage` | yes | `lysis` / `bind` / `wash` / `elute` / `setup` / `master_mix` / etc. |
| `shareable_prep` | yes | `yes` or `no` |
| `hazard_or_handling_flag` | yes | short flag string (free-form) |
| `epa_lookup_key` | yes | unique key — joins to `data/epa_cache.json` |
| `cas` | **strongly recommended** | added so the EPA build script can hit CompTox / TRI / RCRA reliably |
| `protocol_examples` | yes | pipe-separated protocol names |

`cas` is technically optional. When absent, the build script falls back to looking up by `normalized_name`, which is much less reliable for buffers and proprietary mixes.
