# Changes To Be Made For Pilot

v1 takes "any molecular-biology protocol PDF in, coordinated week plan out":
the LLM extracts structured fields per upload, the user confirms them, and the
deterministic engine schedules the week and surfaces shared-reagent /
shared-equipment overlaps. This file tracks (a) how the current build actually
behaves where it's non-obvious, and (b) the harder problems still punted to
pilot.

---

## Current build — notes for whoever picks this up

- **The LLM pipeline runs on Anthropic (Claude Sonnet 4.6).** Parser, narrator,
  and the legacy matcher all go through `lib/llm/client.ts` (`@anthropic-ai/sdk`).
  Requires `ANTHROPIC_API_KEY` in `.env.local`. Every model call prints a
  one-line token + cost estimate to the server terminal
  (`[claude] claude-sonnet-4-6 in=… out=… → $…`).

- **EPA hazard data is a cached lookup, NOT a live API call.** At parse/plan
  time nothing hits the EPA/CTX API. Hazard summaries are read from
  `data/epa_cache.json`, which is rebuilt offline by `npm run epa:build` — that
  script is the only thing that uses `EPA_CCTE_API_KEY`. A reagent gets hazard
  data only if its confirmed overlap group has a cache entry; freshly-coined
  ("new") groups get none.

- **Coordination ranking is an ordinal hazard rank, NOT dollars.** Each
  reagent-prep coordination carries `savings.hazard_rank` (0 = benign aqueous,
  1 = TRI-listed, 2 = hazardous CompTox flag, 3 = RCRA-regulated), derived
  purely from the cached EPA hazard class. The scheduler places higher-rank
  coordinations first so they win slot contention; the loser becomes an
  "Advisory" card. There is **no cost model and no dollar figure anywhere** —
  "$ saved" is intentionally not computed.

- **Multiple protocols per labmate** are supported in the form
  (`components/HomeForm.tsx`); each protocol becomes its own engine task.

- **Equipment overlaps show a "not validated against your lab" warning.** This
  is a stopgap — the equipment catalog is still a single hardcoded mock lab
  (see "Per-lab equipment catalog" below).

---

## Still to do for pilot

### Extending to new protocol families (beyond extraction / PCR / cleanup)

The product is meant for labs in general, not just the three families the
current build is tuned for (DNA extraction, PCR, bead cleanup). The generic
backbone of `DraftProtocol` — `reagents[]`, `equipment_required[]`,
`samples_default/max`, `vendor`, `primary_technique` — already carries over to
almost any wet-lab protocol unchanged. What does NOT carry over, and needs a
bounded per-family redesign:

- **Schema:** the only protocol-specific structured field today is
  `thermal_profile` (PCR-only). A genuinely different protocol has its own
  structured core that has no slot in the current shape — e.g. a Western blot's
  antibody panel + incubation series, a gel run's voltage/run-time, qPCR
  fluorescence channels, a gradient spin's rotor speeds, timepoint series.
  Add a new optional sub-object (mirroring how `thermal_profile` is added and
  defaulted to `null`) plus the matching `family` enum value.
- **Closed vocabularies:** `generic_overlap_group`, equipment types, and the
  reagent `stage` list are curated in the seed CSVs for the three current
  families. A new family needs new entries (or the LLM falls back to `"new"` /
  `"other"` and loses coordination data).
- **Engine:** `lib/engine/duration.ts` has PCR-specific timing math + a setup
  constant; a new family needs its own duration model branch. The
  coordination/overlap logic (shared-reagent prep, shared-equipment runs,
  hazard ranks) also encodes extraction/PCR assumptions and may need new rules.

This is a real extension, not a rewrite. **The expectation is that the pipeline
is custom-fit per lab** to that lab's protocol mix and instruments, so updating
the schema + vocabularies + engine for each new family/lab is an accepted,
recurring part of onboarding — not a sign something is wrong. When this happens,
also follow the structured-outputs direction in "LLM follow-ups" below so the
new schema is enforced by constrained decoding rather than post-hoc rejection.

### Real reagent cost

The ranking is a hazard ordinal, not money. For a real "$X saved" number
(the most attention-grabbing figure for a PI), add per-reagent cost: a curated
/ lab-maintained price list keyed by `generic_overlap_group` or CAS (vendor
purchase-price APIs — Sigma / Thermo / NEB — aren't openly queryable). Then
surface a "$ saved" line in the impact card, separate from CO2e. Equipment-run
coordinations also need a value model (today only reagent-prep coordinations
carry a `hazard_rank`).

### Live EPA / CTX lookups in the parse path

The parser extracts a `cas_number` when one is visible, but we never resolve it
against CTX/TRI at request time — hazard data is inherited from the confirmed
overlap group or left null. Live lookups add latency (200–2000 ms per CAS) and
a new caching surface. Pilot plan: on confirmation of a `new` overlap group,
fire a background job that resolves each CAS against CTX and persists it into
`data/epa_cache.json`; show a "fetching hazard data…" badge, degrading to
"verify with SDS" on failure.

### Persistent overlap-group confirmations

When the user confirms "Wash Buffer X → `ethanol_wash_solution`" during review,
that mapping lives in React state and is lost on refresh. Pilot options:
log every confirmation to an append-only JSONL file and promote high-confidence
entries into `data/seed/reagent_term_map.csv` weekly; or, once there are lab
accounts, scope confirmations per-lab with a "promote to global" workflow.

### Persistent protocol cache across uploads

Every upload re-runs the LLM extraction. Hash the PDF (SHA-256) on upload and
cache the extracted draft + confirmed mappings by hash, so re-uploading the
same vendor handbook is free after the first time.

### Per-lab equipment catalog

`data/seed/equipment.csv` is a single fixed mock lab. The LLM reports a
free-text equipment hint and `lib/engine/resolveDraft.ts` fuzzy-matches it
against that catalog; a real lab's instruments degrade to "unknown" and can't
be reserved (hence the stopgap UI warning above). Pilot: a small admin screen
where a lab lists its instruments (type, capacity, model); the catalog becomes
per-account.

### LLM follow-ups

- **Provider-side structured outputs — DONE (with fallback).** The parser now
  sends a plain JSON Schema (`parseProtocolJsonSchema()` in `lib/llm/schemas.ts`)
  via Anthropic `output_config.format` (see `generateJson({ jsonSchema })` in
  `lib/llm/client.ts`). Where the endpoint/SDK supports it, output is
  grammar-constrained (verified live on Sonnet 4.6); where the endpoint doesn't
  support `output_config` at all, the client detects it once
  (`structuredOutputSupported` memo) and degrades to prompt + zod. zod stays
  authoritative in both paths. The old Gemini OpenAPI-style builders
  (`geminiResponseSchemaFor*`) have been removed. NOTES: (1) the GA request
  shape is `output_config.format = { type, schema }` — do NOT add a `name` key
  inside `format`, the API rejects it ("Extra inputs are not permitted").
  (2) the SDK version pinned here doesn't yet *type* `output_config`, so it's
  attached via a widened cast — drop the cast once the SDK types it. Companion
  robustness (canonicalizer, tiered zod, one-shot repair) is in `HOW_IT_WORKS.md`.
- **Consider Opus 4.8 for the parser** if Sonnet 4.6 misses on the densest
  vendor handbooks — per-parse cost (~$0.18) is still trivial against the credit.
