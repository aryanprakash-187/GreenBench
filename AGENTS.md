# AGENTS.md — LabSync context primer

Read this first. It is the fast-path orientation for any model picking up this
repo so you don't have to re-read everything to be productive. Deeper detail
lives in `ChangesToBeMadeForPilot.md` (product/pilot notes), `BUGS_TODO.md`
(deferred bugs), `README.md`, and `docs/`.

## What this is

**LabSync** — "any molecular-biology protocol PDF in,
coordinated week plan out." The LLM extracts structured fields from each
uploaded protocol PDF, the user confirms them in the UI, and a deterministic
engine schedules the week and surfaces shared-reagent / shared-equipment
overlaps across labmates. Next.js 14.2 (App Router, `nodejs` runtime), React 18,
TypeScript, Tailwind, zod v4. LLM = **Anthropic Claude** (`@anthropic-ai/sdk`).

## Pipeline (the mental model)

```
upload PDF
  └─ POST /api/parse ─ lib/llm/parseProtocol.ts ── Claude ──▶ DraftProtocol   (Layer 1.5)
       (text extracted via lib/llm/pdfText.ts; falls back to raw PDF bytes)
  └─ user confirms overlap groups in components/ProtocolDraftReview.tsx        (Layer 1.6)
  └─ lib/engine/resolveDraft.ts ──▶ EnrichedProtocol                           (Layer 2)
  └─ POST /api/plan ─ lib/engine/* (scheduler, impact, compatibility) ─▶ WeekPlanResult (Layer 3)
  └─ POST /api/narrate ─ lib/llm/narrate.ts ── Claude ──▶ prose for the cards  (Layer 4)
  └─ POST /api/export ─ lib/export/ics.ts ──▶ .ics calendar
```

- A `DraftProtocol` is deliberately **pre-resolution**: it keeps the LLM's
  uncertainty (null volumes, *proposed* overlap groups, free-text equipment
  hints). Nothing reaches the engine until the user confirms.
- The engine (`lib/engine/`) is **pure code** — no LLM, no fs writes, no
  network. Hazard data is a cached offline lookup (`data/epa_cache.json`,
  rebuilt by `npm run epa:build`), NOT a live API call at request time.

## Key files

| Concern | File |
| --- | --- |
| Anthropic client (timeouts, retries, **prompt caching**, cost logging) | `lib/llm/client.ts` |
| PDF → DraftProtocol extractor | `lib/llm/parseProtocol.ts` |
| Parser prompt (the source of truth for output shape) | `lib/llm/prompts/parseProtocol.md` |
| **All zod schemas the LLM output must satisfy** | `lib/llm/schemas.ts` |
| Engine types (DraftProtocol, EnrichedProtocol, ThermalProfile, …) | `lib/engine/types.ts` |
| Draft → EnrichedProtocol resolver | `lib/engine/resolveDraft.ts` |
| Scheduler / impact / compatibility | `lib/engine/{scheduler,impact,compatibility,duration}.ts` |
| Upload form / review UI | `components/{HomeForm,ProtocolDraftReview}.tsx` |
| API routes | `app/api/{parse,plan,match,narrate,export,hydrate}/route.ts` |

## Conventions & gotchas

- **Models:** default `claude-sonnet-4-6` (parser/narrator). Prices in
  `PRICE_PER_MTOK` in `client.ts` — keep in sync if you add a model. Each call
  logs `[claude] <model> in=… out=… cache(w=… r=…) → $…` to the server
  terminal. `cache r>0` on a repeat call = prompt caching is working.
- **The LLM contract is dual:** the prompt (`prompts/*.md`) describes the shape;
  zod (`schemas.ts`) enforces it. **If you change one, change the other.** A zod
  mismatch throws `SCHEMA_MISMATCH`, which is intentionally NOT retried.
- **Schema robustness:** Claude is not fully deterministic even at
  `temperature: 0`, so parser schemas are written to *tolerate* reasonable
  variation (`.catch()` fallbacks on non-load-bearing fields, lenient numeric
  coercion on `thermal_profile`) rather than hard-fail the whole parse. Keep
  required, load-bearing fields strict; make cosmetic/hint fields lenient.
- **Week picker (`components/HomeForm.tsx`):** the form now has an explicit
 "Week to plan" `<select>` (`buildWeekOptions()`, next 8 Mondays) whose ISO
 value is sent as `week_start_iso` in the `/api/plan` body — previously this
 was always omitted and silently defaulted server-side to
 `nextMondayLocalIso()`. This does NOT require pre-slicing the uploaded
 `.ics` file: `lib/engine/ics.ts`'s `parseIcsToBusy(icsText, weekStartIso)`
 already clips busy intervals to `[week_start, week_start + 7d)` for
 scheduling purposes, regardless of how much history/future the uploaded
 calendar file contains (e.g. a full Google Calendar export). The exporter
 (`lib/export/ics.ts`) is intentionally the opposite — it passes through
 *every* original VEVENT unfiltered so the person's downloaded calendar
 keeps their whole life, not just the planned week; don't "fix" that to
 match the importer's clipping without re-confirming with the user.
- **Prompt caching:** parser sends bulky static instructions as a cached
  `system` block and marks the document block with `cache_control` so identical
  re-uploads within ~5 min are near-free. See `generateJson` options
  `system` + `cacheUserPrefix` in `client.ts`.
- **LLM→engine contract is 4-layered (see `HOW_IT_WORKS.md`):** (1) structured
  outputs — `generateJson({ jsonSchema })` sends `output_config.format`,
  grammar-constraining output where the API supports it and auto-falling back to
  prompt+zod where it doesn't (`structuredOutputSupported` memo in `client.ts`;
  schema built by `parseProtocolJsonSchema()`); (2) a deterministic
  canonicalizer reshapes variable inputs like `thermal_profile` before zod
  (`canonicalizeThermalProfile` in `schemas.ts`); (3) tiered strictness — strict
  on `reagents`/`raw_term`/`proposed_overlap_group`, lenient `.catch()` on
  cosmetic fields; (4) one-shot repair — `generateJson({ repairOnInvalid })`
  re-prompts once with the zod error. zod is always the final authority.
- **Cost/energy overlay (RemainingWork Items 1/2/6):** equipment coordinations
 now carry `kwh_saved` + `usd_saved` (+ energy CO2e folded into `co2e_kg_range`)
 in addition to `runs_saved`. kWh is DERIVED as `power_draw_kw_active ×
 (run_duration_min/60)` from `data/seed/equipment.csv` (both columns added);
 `usd_saved = runs_saved × cost_per_run_usd` (non-zero only for the sequencer).
 Grid factor is a single grounded value in `impact_coefficients.json`
 (`equipment_energy.grid_co2e_kg_per_kwh = 0.195`, eGRID CAMX) read via
 `gridCo2ePerKwh()`. All $/kWh/CO2e figures are tagged "pilot est." in
 `OverviewPage.tsx`; physical counts stay unlabeled.
- **Sequencing is a first-class family, not a derived step.** A pooled MiSeq run
 is modeled as an uploaded `Sequencing`-family protocol whose load-bearing input
 is sample count; it reuses the existing `buildEquipmentCoordinations` capacity
 batching (sum samples ≤ `sequencer` capacity → `runs_saved`). New `Sequencing`
 enum value lives in `types.ts` (DraftProtocol.family) + `schemas.ts`
 (FAMILY_VALUES), `FAMILY_ORDER` (scheduler, rank 3 = after cleanup),
 `FAMILY_BASELINES` (duration = hands-on load time, NOT the ~24h run), and
 `FAMILY_TONES` (UI). The `sequencer` equipment type is aliased in
 `resolveDraft.ts` and seeded as `miseq-i100-1`.
- **Closed vocabularies:** `protocol_name` and `proposed_overlap_group` enums
  are built at module load from seed CSVs (`lib/engine/data.ts`) — this is what
  makes hallucination structurally hard. `"new"` is the overlap-group escape
  hatch the user confirms in the UI.
- **Structured-output schema:** `parseProtocolJsonSchema()` in `schemas.ts` is
  the JSON Schema sent to Anthropic. Keep it in sync with the zod parse schema
  in the same file. (The old `geminiResponseSchemaFor*` helpers have been
  removed.)
- **Dev compile is slow** (`next dev` cold-compiles on demand; the MacBook Air
  can take minutes for the first route). It's a one-time per-route cost, not
  runtime/API latency, and irrelevant to production (`next build`). Use
  `npm run dev:turbo` for faster dev compiles.
- **Sequencing-run cards + the duplicate-name caveat:** `components/HomeForm.tsx`
  has a separate "sequencing runs" section (`SequencingRun`, no PDF — a fixed
  `buildSequencingDraft()` template, sample count is the only variable) in
  addition to the labmate cards. Each sequencing run becomes its OWN entry in
  the `people[]` array sent to `/api/plan` — it is deliberately NOT merged
  into a labmate card even when the name matches, per product decision. This
  is only correct because the intended usage is to upload that same person's
  SAME `.ics` file again in the sequencing card. The engine has no concept of
  "this is the same person as that other entry" — `lib/engine/scheduler.ts`'s
  `freeByPerson` map is keyed by name string, so two `people[]` entries
  sharing a name silently overwrite each other's calendar (last one processed
  wins, no error). `components/SchedulesPage.tsx`'s `buildPersonRows` has the
  same last-one-wins-by-name shape for the exported-calendar preview. If a
  future change lets one name carry two DIFFERENT calendars, both of these
  need a real fix (e.g. merge calendars by name, or reject duplicate names
  with conflicting schedules) — don't just patch one call site.

## Commands

```bash
npm run dev          # dev server (slow cold compile)
npm run dev:turbo    # dev server with Turbopack (faster compiles)
npm run build        # production build
npm run parse:test   # exercise the parse layer (scripts/test-parse-layer.ts)
npm run llm:test[:live]      # LLM layer tests (:live actually calls Claude)
npm run narrate:test[:live]  # narrator tests
npm run epa:build    # rebuild data/epa_cache.json (only thing using EPA API)
```

Requires `ANTHROPIC_API_KEY` in `.env.local`. `EPA_CCTE_API_KEY` only used by
`epa:build`.

## How to update this file

When you make a structural change (new pipeline stage, new key file, changed
LLM contract, new gotcha), add a line here so the next model inherits it. Keep
it terse — this file is meant to be cheap to keep in context.
