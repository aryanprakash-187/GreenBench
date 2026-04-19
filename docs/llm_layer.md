# LLM layer + hydration — implementation notes

What this document covers: the code that landed in this pass — the upload-side
LLM matcher, the deterministic hydration step that joins all seed CSVs with EPA
data and the lab catalog, and the two API routes that expose them. Read this
alongside the project `README.md`; this doc is the "how it actually works" for
the LLM layer specifically.

If you only read one section, read [Mental model](#mental-model).

---

## Mental model

The README is explicit: the LLM lives **at the edges**, never in the middle.
That principle is what shaped everything below.

```
┌──────────┐   ┌─────────────────────┐   ┌─────────────────┐   ┌──────────────┐   ┌─────────────────────┐
│  upload  │ → │ ProtocolMatchResult │ → │ EnrichedProtocol│ → │ WeekPlanResult│ → │ NarratedWeekPlanRes │
└──────────┘   └─────────────────────┘   └─────────────────┘   └──────────────┘   └─────────────────────┘
                  ▲                          ▲                     ▲                  ▲
                  │                          │                     │                  │
              tier 1/2/3                pure-code join         deterministic       LLM (deferred)
              matcher                   of CSVs + EPA          engine
              (LLM at tier 3 only)      + equipment            (NOT built yet)
              ────────────────          ────────────────       ────────────────    ────────────────
              built this pass           built this pass        Person A workstream Person A workstream
```

Two principles fall out of this layout:

1. **The LLM has a closed vocabulary.** It can only emit one of nine
   `protocol_name` values from `data/seed/protocols_selected.csv`. The Gemini
   response schema is a literal enum; a hallucinated 10th protocol is
   structurally impossible.
2. **Safety-relevant data never touches the LLM.** EPA hazard codes, RCRA
   classifications, waste compatibility — all joined deterministically at
   hydration time. The LLM never sees them, never emits them, can't get them
   wrong.

---

## What was built

### 1. `lib/engine/types.ts`

The contract for everything downstream. Defines:

- **`EnrichedReagent`** — one reagent inside a hydrated protocol with its volume,
  stability window, batch-prep eligibility, EPA hazard summary, and impact
  coefficient all bound in.
- **`EnrichedProtocol`** — the unit the (future) engine schedules. Every reagent
  enriched, equipment bound to a concrete lab catalog row, thermal profile
  attached for PCR.
- **`ProtocolMatchResult`** — what the matcher emits.
- Source CSV row types (`ProtocolReagentRow`, `ReagentTermMapRow`, etc.) so
  loaders are typed end-to-end.

### 2. `lib/engine/data.ts`

Server-side, memoized loaders for all 8 seed sources:

| Loader | Reads | Used for |
| --- | --- | --- |
| `loadProtocols()` | `data/seed/protocols_selected.csv` | the 9 curated protocols |
| `loadReagentTermMap()` | `data/seed/reagent_term_map.csv` | normalize raw vendor terms → overlap groups |
| `loadProtocolReagents()` | `data/seed/protocol_reagents.csv` | per-sample volumes |
| `loadThermalProfiles()` | `data/seed/protocol_thermal_profiles.csv` | PCR thermal profiles |
| `loadReagentStability()` | `data/seed/reagent_stability.csv` | shelf life per overlap group |
| `loadOverlapRules()` | `data/seed/overlap_rules.csv` | batch-prep eligibility |
| `loadEquipment()` | `data/seed/equipment.csv` | lab equipment catalog |
| `loadEquipmentTermMap()` | `data/seed/equipment_term_map.csv` | equipment normalization |
| `loadEpaCache()` | `data/epa_cache.json` | EPA hazard / RCRA / citation data |
| `loadImpactCoefficients()` | `data/impact_coefficients.json` | per-reagent CO₂e ranges |

All loaders are **server-only** (they call `fs`). They cache the parsed rows in
module-scoped variables so the second-and-onward call is free. `__resetCaches()`
exists for tests.

### 3. `lib/engine/hydrate.ts` — the join

Input: `{ protocol_name, sample_count }`.
Output: a fully-bound `EnrichedProtocol`.

This is pure code, no LLM, no network. The exact join, in order:

```
1. protocols_selected.csv             → family, vendor, primary_technique
2. protocol_reagents.csv              → reagents + per-sample volumes
   ├─ multiply each volume × sample_count → volume_total_ul
3. reagent_term_map.csv (per reagent) → normalized_name, generic_overlap_group,
                                        epa_lookup_key, hazard flags
4. reagent_stability.csv              → stable_hours_after_prep
5. overlap_rules.csv                  → batch-prep eligibility (max_batch_ml, etc.)
6. epa_cache.json                     → RCRA code, incompatibilities, EPA citation URLs
7. impact_coefficients.json           → CO₂e per liter (low/mid/high)
8. protocol_thermal_profiles.csv      → PCR thermal profile (PCR protocols only)
9. Equipment resolution               → bind to lab catalog
   primary_technique
     → TECHNIQUE_EQUIPMENT_GROUPS    (in hydrate.ts)
     → equipment_group(s)
     → EQUIPMENT_GROUP_TO_CATALOG_TYPE (in hydrate.ts)
     → equipment.csv lookup           → lab_id, capacity, model
   plus equipment_term_map.csv       → batchable flag
```

#### Why two equipment maps?

`equipment.csv` (lab catalog) and `equipment_term_map.csv` (vendor normalization)
were curated independently and use different taxonomies — the catalog says
`type: "magnetic_plate"` while the normalization says `equipment_group:
"magnet_plate_96"`. Rather than force one to change, `hydrate.ts` carries two
small translation tables:

- `TECHNIQUE_EQUIPMENT_GROUPS` — `primary_technique` → required `equipment_group`s
- `EQUIPMENT_GROUP_TO_CATALOG_TYPE` — `equipment_group` → catalog `type`

If the data leads later unify the two taxonomies, both tables can collapse to a
direct join.

#### Errors thrown

`hydrate.ts` throws `HydrateError` with one of these codes when a CSV gap is
detected — fail loudly during dev rather than silently shipping bad data:

- `INVALID_SAMPLE_COUNT` — sample_count not a positive number
- `UNKNOWN_PROTOCOL` — protocol_name not in `protocols_selected.csv`
- `NO_REAGENTS` — no rows in `protocol_reagents.csv` for this protocol
- `UNMAPPED_REAGENT` — a reagent's `raw_term` is missing from
  `reagent_term_map.csv`

### 4. `lib/llm/matchProtocol.ts` — the three-tier matcher

Resolves an uploaded file to one of the 9 curated `protocol_name` values.
Always resolves; never throws. The tiers:

#### Tier 1 — filename normalization (no LLM, no I/O)

The filename is normalized into two parallel forms — a CamelCase-split form
(`PlatinumII_HotStart` → `platinum ii hot start`) AND a compact form (`DNeasy`
stays `dneasy`). Vendor brand names are matched against either.

A per-protocol alias table lives in `PROTOCOL_ALIASES` — vendor codenames,
catalog numbers (`A63881`, `M0494`, `K0721`), and family handles. New aliases
get added there as new vendor filename patterns are discovered.

#### Tier 2 — keyword scan over text

When the filename alone is ambiguous, scan the first ~8 KB of file text for
weighted vendor + reagent + technique keywords. Per-protocol patterns live in
`PROTOCOL_KEYWORDS`. Examples:

- "DNeasy Blood & Tissue" → `Buffer ATL`, `Buffer AW1`, `Buffer AE`, "QIAGEN"
- "Q5 Hot Start" → `\bq5\b`, "98°C denaturation", "NEB"
- "AMPure XP" → "1.8x bead ratio", "SPRIPlate"

Scores from tier 1 and tier 2 are merged. If the merged top candidate clears
the confidence floor (0.55) AND beats the runner-up by at least 0.10, the
matcher returns it without ever hitting the LLM.

#### Tier 3 — Gemini tiebreaker (only when needed)

Only fires when:

- Tiers 1+2 are inconclusive (top score < floor or top two too close), AND
- `GEMINI_API_KEY` is set, AND
- We have either a text excerpt or the raw file bytes to send

Gemini is called in JSON mode with a **response schema where `protocol_name` is
a literal enum of the 9 valid values**. Validated through zod before returning.
On any failure (timeout, invalid JSON, schema mismatch), the matcher logs the
reason and falls back to the deterministic best guess — **never crashes the
demo**.

#### Confidence behavior

- ≥ 0.55 with clear lead → return immediately
- < 0.55 or ambiguous → escalate to next tier
- All tiers exhausted with no clear winner → return `protocol_name: null`,
  `matched_via: 'none'`, and the UI is expected to show a disambiguation dropdown

### 5. `lib/llm/client.ts` — Gemini wrapper

Centralizes:

- API key handling (server-only env)
- JSON-mode generation with a `responseSchema`
- 10 s hard timeout
- PDF / arbitrary-binary input via `inlineData` (Gemini 1.5+ accepts PDFs natively)
- zod validation before returning

Throws `LlmClientError` with one of: `NO_API_KEY`, `TIMEOUT`, `EMPTY_RESPONSE`,
`INVALID_JSON`, `SCHEMA_MISMATCH`, `UPSTREAM_ERROR`. The matcher catches these
and falls through to deterministic results.

### 6. `lib/llm/schemas.ts` — closed vocabulary enforcement

Builds the LLM response schema at module load by reading the 9 protocol names
from `protocols_selected.csv`. The zod schema and the Gemini `responseSchema`
both enforce the same enum. This is what makes hallucination structurally
impossible.

### 7. `lib/llm/prompts/matchProtocol.md` — versioned prompt

Plain markdown so it's easy to tune and review in PRs without touching code.
Contains the rules ("you may only return one of these nine names verbatim"),
the calibration scale for `confidence`, and instructions for `reasons` (cite
quoted phrases, not paraphrase).

### 8. `app/api/match/route.ts` — POST endpoint

Accepts either:

- `multipart/form-data` with field `file` (and optional `samples`, `hydrate=1`)
- `application/json` with `{ filename, text_sample?, samples?, hydrate? }`

Returns:

```json
{
  "match": { "protocol_name": "...", "confidence": 0.95, "matched_via": "filename", "candidates": [...], "notes": "..." },
  "enriched": { ... EnrichedProtocol ... } | null
}
```

When `hydrate=1`, runs the match AND the join in one round trip — that's the
endpoint the UI form should hit.

### 9. `app/api/hydrate/route.ts` — POST endpoint

For when the user picked a protocol from a dropdown rather than uploading a
file. Body: `{ protocol_name, sample_count }`. Returns the same `EnrichedProtocol`.

### 10. `scripts/test-llm-layer.ts` — smoke test

Nine fixture filenames (one per curated protocol), each asserted to:

1. Match to the expected `protocol_name` (deterministic tiers only — offline-safe)
2. Hydrate without throwing
3. Have non-zero total reagent volumes after `sample_count` multiplication
4. Have at least one reagent with an EPA hazard summary attached
5. Have a `thermal_profile` if (and only if) it's a PCR protocol

Run:

```bash
npm run llm:test         # offline — deterministic tiers only
npm run llm:test:live    # also exercises Gemini (requires GEMINI_API_KEY)
```

Current status: **9/9 passing offline.**

---

## How to use it

### From the UI

The current `components/HomeForm.tsx` uploads the file but only stubs into
sessionStorage. To actually run the LLM layer, post the file to `/api/match`:

```ts
const form = new FormData();
form.append('file', person.protocol);
form.append('samples', person.sampleCount);
form.append('hydrate', '1');

const res = await fetch('/api/match', { method: 'POST', body: form });
const { match, enriched } = await res.json();

// `match` shows confidence + alternatives (UI can render a "did you mean" dropdown)
// `enriched` is the EnrichedProtocol the engine will consume
```

### From a script

```ts
import { matchProtocol } from '@/lib/llm/matchProtocol';
import { hydrateProtocol } from '@/lib/engine/hydrate';

const match = await matchProtocol({
  filename: 'DNeasy_Blood_and_Tissue_Handbook.pdf',
  disable_llm: true,  // pure offline
});
// → { protocol_name: "DNeasy Blood & Tissue", confidence: 0.85, matched_via: "filename", ... }

const enriched = hydrateProtocol({
  protocol_name: match.protocol_name!,
  sample_count: 8,
  matched_via: match.matched_via === 'none' ? 'manual' : match.matched_via,
});
// → fully-joined EnrichedProtocol
```

---

## What this layer does NOT do

Calling out gaps explicitly so nothing is fuzzy:

| Component | Status |
| --- | --- |
| LLM matcher (Layer 1) | ✅ done |
| Hydrate (Layer 2) | ✅ done |
| **Engine matcher** (`lib/engine/matcher.ts`) | ❌ NOT built |
| **Engine scheduler** (`lib/engine/scheduler.ts`) | ❌ NOT built |
| **Engine compatibility** (`lib/engine/compatibility.ts`) | ❌ NOT built |
| **Engine impact** (`lib/engine/impact.ts`) | ❌ NOT built |
| Narrator (`lib/llm/narrate.ts`) | ❌ deferred (needs engine output to narrate) |
| `HomeForm.tsx` wired to `/api/match` | ❌ still uses sessionStorage stub |

The engine is what turns a list of `EnrichedProtocol`s into the `WeekPlanResult`
the README describes (coordinations, separations, impact). It's the next
workstream.

---

## Gemini API key + cost

### Getting a key (free, 2 minutes)

1. Visit **https://aistudio.google.com/app/apikey**
2. Sign in with any Google account → click **"Create API key"**
3. Copy the key (starts with `AIza...`)
4. Add to `.env.local`:

   ```
   GEMINI_API_KEY=AIza...
   ```

5. Restart dev server. Verify with `npm run llm:test:live`.

The free tier covers 15 requests/min and 1500/day on Gemini 1.5 Flash — far
more than the demo will ever consume.

### Cost (Gemini 1.5 Flash, current pricing)

- **Input:** $0.075 / 1M tokens (≤128K context window)
- **Output:** $0.30 / 1M tokens

Per call:

| Call | Tokens (in / out) | Cost |
| --- | --- | --- |
| `matchProtocol` (text excerpt) | ~1,700 / ~80 | ~$0.00015 (≈ 1/65 of a cent) |
| `matchProtocol` (full PDF attached) | ~10,000 / ~80 | ~$0.0008 (≈ 1/12 of a cent) |
| `narrate` (when built) | ~3,000 / ~1,500 | ~$0.0007 (≈ <1 cent) |

A full demo run costs **well under a cent**. The free tier covers the entire
hackathon weekend without billing.

---

## Design decisions worth knowing

- **Closed-enum schema** for protocol_name. Most LLM safety failures come from
  freeform string outputs the engine then tries to parse. We avoid that by
  letting Gemini pick from a list, not generate a name.
- **Three-tier matching with the LLM as last resort.** Demo path almost never
  touches Gemini, so the demo can't be killed by an API outage. The LLM tier
  exists for the long-tail vendor PDF whose filename doesn't match an alias.
- **Hydration is sync and pure.** Not async, doesn't hit the network, doesn't
  cache results outside the in-memory CSV cache. This means the engine — when
  it lands — can call it inside a tight loop without thinking about I/O.
- **`HydrateError` codes are strict.** A missing reagent throws rather than
  returning a partial protocol. We want CSV gaps surfaced loudly during dev,
  not silently in production.
- **Equipment translation tables in code, not data.** The two equipment
  taxonomies could be unified in CSV, but doing it in code means the data
  leads can keep their column conventions and either taxonomy can evolve
  independently until we're ready to pick one.
- **Server-side everything.** `lib/engine/data.ts` calls `fs`. Never import
  from client components. The API routes are the boundary.

---

## File map

```
lib/engine/
  types.ts              ~250 lines  — contracts: EnrichedProtocol, ReagentHazardSummary, etc.
  data.ts               ~170 lines  — memoized loaders for all 8 seed sources
  hydrate.ts            ~280 lines  — the deterministic join

lib/llm/
  schemas.ts             ~70 lines  — zod + Gemini-response-schema enforcing the 9-protocol enum
  client.ts             ~140 lines  — Gemini wrapper (JSON mode, schema, timeout, PDF inlineData)
  matchProtocol.ts      ~370 lines  — three-tier matcher
  prompts/
    matchProtocol.md                — versioned LLM prompt template

app/api/
  match/route.ts                    — POST: file upload → match (+ optional hydrate)
  hydrate/route.ts                  — POST: protocol_name + sample_count → enriched

scripts/
  test-llm-layer.ts                 — 9-fixture smoke test (offline + live modes)

.env.local.example                  — documents GEMINI_API_KEY
package.json                        — adds llm:test, llm:test:live; deps: zod, @google/generative-ai
tsconfig.json                       — excludes scripts/ from Next typecheck
```
