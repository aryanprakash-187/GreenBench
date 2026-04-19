# Deterministic engine — implementation notes

What this document covers: the code that landed in this pass — the
deterministic engine (Layer 3) that turns hydrated protocols into a coordinated
week plan. Read this alongside `README.md` and `docs/llm_layer.md`; this doc
is the "how it actually works" for the engine.

If you only read one section, read [Mental model](#mental-model).

---

## Mental model

The README is explicit: **the engine handles what the LLM will hallucinate
on**. Reagent matching, waste-stream compatibility, and scheduling are all
table lookups and structured comparisons — never an LLM call. That principle
is what shaped everything below.

```
┌──────────┐   ┌─────────────────────┐   ┌─────────────────┐   ┌──────────────┐   ┌─────────────────────┐
│  upload  │ → │ ProtocolMatchResult │ → │ EnrichedProtocol│ → │ WeekPlanResult│ → │ NarratedWeekPlanRes │
└──────────┘   └─────────────────────┘   └─────────────────┘   └──────────────┘   └─────────────────────┘
                  ▲                          ▲                     ▲                  ▲
                  │                          │                     │                  │
              tier 1/2/3                pure-code join         deterministic       LLM (deferred)
              matcher                   of CSVs + EPA          engine
              (LLM at tier 3 only)      + equipment            ────────────────    ────────────────
              ────────────────          ────────────────       built this pass     deferred
              previous pass             previous pass
```

Three principles fall out of this layout:

1. **Engine in, engine out.** `planWeek(EnginePlanInput) → WeekPlanResult` is
   the entire surface area. Pure synchronous TypeScript — no `fetch`, no LLM,
   no `await`. Every dependency (seed CSVs, EPA cache) is loaded once at
   process start by the data layer and memoized.
2. **Safety-relevant data drives recommendations directly.** Waste-stream
   separations come from `waste_rules_map.csv` joined with `epa_cache.json`.
   The narrator (Layer 4) will rephrase the engine's `recommendation` strings
   into prose, but it cannot invent or remove a separation — those are emitted
   structurally.
3. **The greedy scheduler is honest about what it can't do.** When a task
   doesn't fit, it lands in `diagnostics.unscheduled` with a reason. When a
   coordination's participants couldn't be aligned in mutually-free time, the
   coordination is emitted with `aligned: false` and the savings are surfaced
   as advisory. No silent drops.

---

## What was built

### 1. `lib/engine/types.ts` (extended)

Adds the engine's I/O contract on top of the existing hydration types:

- **`EnginePlanInput`** — top-level input: `week_start_iso` (Monday 00:00 of
  the planning week) plus a `people: EnginePerson[]`. Each person has a name,
  optional `operator_id` (joins to `operators.csv` for availability), already-
  parsed `busy: BusyInterval[]`, and `tasks: HydratedTask[]`.
- **`HydratedTask`** — pairs a stable `task_id` (e.g.
  `sohini__dneasy_blood_tissue__1`) with a fully-bound `EnrichedProtocol`.
- **`WeekPlanResult`** — the output: `schedule[]`, `coordinations[]`,
  `separations[]`, `impact`, `diagnostics`.
- **`Coordination`** — a shared-prep or batched-equipment opportunity.
  Discriminated by `type: 'shared_reagent_prep' | 'shared_equipment_run'`.
  Carries participants, a placeholder `recommendation` string the narrator
  will replace, structured `savings`, EPA `citations`, and an `aligned`
  flag the scheduler flips.
- **`Separation`** — a waste-stream conflict between two tasks. Carries
  `severity` (`critical` / `warning` / `info` / `check`), the offending
  `pair`, and `citations` joining each side back to its EPA cache entry.
- **`ImpactSummary`** — `weekly` plus a naive `annualized_if_repeated`
  (×52). Counts `reagent_volume_saved_ml`, `prep_events_saved`,
  `equipment_runs_saved`, `hazardous_disposal_events_avoided`, and a CO₂e
  range tuple `[low, high]`.

### 2. `lib/engine/data.ts` (extended)

Added `loadOperators()` (memoized, like the others) so the scheduler can
read availability windows.

### 3. `lib/engine/ics.ts` — busy calendar parser

A hand-rolled ICS parser, ~150 lines, zero new deps.

| Capability | Status |
| --- | --- |
| `BEGIN/END:VEVENT` walking | ✅ |
| `DTSTART` / `DTEND` (UTC, floating, all-day) | ✅ |
| `SUMMARY` with `\n` `\,` `\;` unescaping | ✅ |
| RFC 5545 line unfolding (`\n[ \t]` continuations) | ✅ |
| Clip events to `[week_start, week_start + 7d)` | ✅ |
| Merge overlapping busy blocks | ✅ |
| `RRULE` expansion | ❌ (out of scope for v1; demo calendars are flat) |
| TZID per-event timezones | ❌ (treated as UTC; demo simplification) |

Also exports `nextMondayLocalIso()` — defaults the planning week anchor to
the user's next Monday at 00:00 local time, expressed as an ISO string.

### 4. `lib/engine/duration.ts` — task duration heuristic

Adding a `duration_min` column to a CSV would be data-team work we don't have
time for, so durations come from a small heuristic:

| Family | Formula |
| --- | --- |
| `DNA_extraction` | 90 min base (8 samples) + 1.5 min per extra sample |
| `Bead_cleanup` | 45 min base (12 samples) + 0.5 min per extra sample |
| `PCR` | sum of `thermal_profile` cycle times + 15 min setup |

PCR durations are computed exactly from `protocol_thermal_profiles.csv` — no
heuristic needed because the profile is already in the seed data.

### 5. `lib/engine/matcher.ts` — coordination candidates

Two passes, both pure functions over the hydrated tasks. This module decides
**what** could be shared. The scheduler decides **whether** the shared event
can actually be placed.

#### Reagent overlap

Build a `Map<generic_overlap_group, ReagentContribution[]>`. A reagent
contributes only when its `shareable_prep === true`, it has a
`batch_prep` rule from `overlap_rules.csv`, and `volume_total_ul > 0` (skips
mineral oil overlays etc.). When 2+ distinct tasks contribute to the same
group, emit one `shared_reagent_prep` Coordination.

The savings model:

```
savedMl = max(0, sum(per_task_dead_volume_mL) − prep_overhead_mL)
```

At small sample counts the prep overhead routinely exceeds the dead-volume
saving and `volume_ml` rounds to 0. That's faithful: the win at small scale
is `prep_events_saved`, not volume. CO₂e range scales from
`impact_coefficients.json[overlap_group].co2e_kg_per_liter × savedMl/1000`.

`hazardous_disposal_events_avoided` increments by `(participants − 1)` when
the overlap group is alcohol / isopropanol / chaotropic / master mix.

EPA citations are de-duped by `epa_lookup_key` and attached per-coordination
(not per-task).

#### Equipment batching

Group `(person, task)` tuples by `equipment_group`, then:

- Filter to entries with `batchable === true` and a resolved `lab_id` (no
  point batching equipment that doesn't exist in our catalog).
- For `thermocycler`, segment further by structural equality on the thermal
  profile — two PCRs only batch if their `(cycles, denature, anneal,
  extension)` tuples match exactly. (Q5/Platinum II/JumpStart all have
  different profiles, so they correctly never batch in the demo.)
- For each segment with 2+ members: if combined sample count ≤ capacity,
  emit a fully-batchable Coordination; else emit a partial one suggesting
  fewer-but-larger runs and report `runs_saved` honestly.

### 6. `lib/engine/compatibility.ts` — waste-stream separations

Loads `waste_rules_map.csv` (own loader; not memoized through `data.ts` yet).

For every (task_i, task_j) pair in the week:

1. Derive each task's waste groups from its reagents'
   `epa_lookup_key` values — that column doubles as the waste-group
   identifier per the README.
2. For every cross-task `(group_a, group_b)` pair, look up the rule
   (symmetric — try both orderings).
3. Emit a `Separation` whenever `compatible !== 'yes'`. Skip benign
   `yes`/`info` rows so the UI isn't flooded.
4. Pair-key dedup ensures each pair fires at most once per task pair.
5. Attach EPA citations from `epa_cache.json` for both sides — RCRA codes
   when present, source URLs always.

### 7. `lib/engine/scheduler.ts` — greedy interval scheduler

Per the README: *"imperfect but finds the easy wins. Proper CSP solver is a
day-2 stretch."*

Pipeline:

1. **Build per-person free intervals** = operator availability window
   (`operators.csv` row matched by `operator_id` or by name; default
   weekdays 08:00–22:00) ∩ ¬`busy` events. Free intervals are stored as
   `{ start_ms, end_ms }` for quick arithmetic.
2. **Sort tasks** by descending `coordWeight` (tasks involved in any
   coordination go first so they have the best chance of aligning), then by
   `FAMILY_ORDER` ascending (`DNA_extraction < PCR < Bead_cleanup`) so
   intra-person dependencies resolve naturally, then by descending duration
   as a tiebreaker.
3. **Family-ordering constraint.** For each task, the earliest valid start is
   the maximum end-time of any already-scheduled task by the **same person**
   in an earlier family. Cross-person dependencies are intentionally not
   enforced (per the design conversation).
4. **Equipment-aware placement.** Walk the person's free intervals; for
   each candidate start, check if any required equipment `lab_id` overlaps
   an existing reservation. If conflict, jump past the conflict and retry.
   First slot that fits the duration with no equipment conflict wins.
5. **Reserve.** Carve the chosen window out of the person's free intervals
   and append to the equipment reservation list.
6. **Coordination alignment.**
   - `shared_equipment_run` is `aligned: true` only when all participants
     ended up at the exact same start time. The greedy doesn't try to force
     this; in practice it triggers when two tasks naturally landed at the
     same earliest slot. (Future improvement: a second pass that nudges
     start times to align.)
   - `shared_reagent_prep` is `aligned: true` whenever 2+ participants
     placed. The matcher already validated stability + batchability, so the
     prep is plannable; we don't model the prep block as a separate
     scheduled task in v1.
   - For both: every participating `ScheduledTask` gets the others' task
     IDs appended to `shared_with` and a human-readable `notes` line.

Failures land in `diagnostics.unscheduled` with a reason ("no mutually-free
slot", "equipment unavailable").

### 8. `lib/engine/impact.ts` — week-level rollup

Sums each Coordination's `savings` and computes the annualized projection
(naive `× 52`). Counts `prep_events_saved`, `equipment_runs_saved`,
`hazardous_disposal_events_avoided`, `reagent_volume_saved_ml`, and a CO₂e
range tuple. Numbers are rounded for display:
volume to 0.1 mL, CO₂e to 0.01 kg.

The impact rollup uses **all** coordinations regardless of `aligned` —
per the README, even an unaligned recommendation surfaces an advisory
saving the user could capture by adjusting their schedule.

### 9. `lib/engine/index.ts` — orchestrator

`planWeek(input)` runs:

1. Validate input (`EngineError` on the obvious gaps).
2. `buildReagentCoordinations` + `buildEquipmentCoordinations` →
   coordinations[].
3. `buildSeparations` → separations[].
4. `scheduleWeek` → schedule + diagnostics; mutates `coordination.aligned`
   and `schedule[].shared_with` in place.
5. `rollupImpact` → impact summary.

Returns the assembled `WeekPlanResult`.

### 10. `app/api/plan/route.ts` — POST endpoint

Accepts JSON of the form:

```jsonc
{
  "week_start_iso": "2026-04-20T07:00:00.000Z", // optional; defaults to next Monday local
  "people": [
    {
      "name": "Sohini",
      "operator_id": "op2",                     // optional
      "busy_ics_text": "BEGIN:VCALENDAR…",      // raw .ics file text
      "tasks": [
        {
          "task_id": "sohini__dneasy__1",       // optional; synthesized if absent
          "protocol": { /* EnrichedProtocol from /api/hydrate */ }
        }
      ]
    }
  ]
}
```

Returns a `WeekPlanResult` JSON. `EngineError` → 400/422; anything else → 500.

The route runs the ICS parser inline so the caller can hand it raw `.ics`
file text without preprocessing.

### 11. `scripts/test-engine.ts` — smoke fixture

Runs the demo's signature week (Sohini = DNeasy + MagJET, Vikas = Q5 + AMPure)
through `planWeek` with empty calendars and asserts:

- `low_salt_elution_buffer` coordination fires (DNeasy + MagJET)
- `sterile_water` coordination fires (Q5 + AMPure)
- All 4 tasks land on the schedule
- Vikas's PCR ends before his AMPure cleanup (intra-person family ordering)
- ≥1 waste-stream separation surfaces
- `prep_events_saved > 0`

Run with `npx tsx scripts/test-engine.ts`.

### 12. UI: multi-protocol input (`components/HomeForm.tsx`, `app/results/tabs/PlanTab.tsx`, `components/ResultsView.tsx`)

The engine accepts `tasks: HydratedTask[]` per person. The form now matches:

- Each person has ONE `.ics` schedule (their busy calendar).
- Each person has 1..N protocol entries (`{ file, sampleCount }`), capped at
  4 per person, with an "Add another protocol" button.
- The submission payload (sessionStorage key `greenbench.submission`) now
  shapes as `people: [{ name, schedule, protocols: [{ protocol, sampleCount }] }]`.
- `PlanTab` renders one card per person with all their protocols listed and
  a "samples total" chip summing across entries.
- `ResultsView` summary chip counts total protocols across all people, not
  protocols per person.

This keeps the contract aligned with `EnginePlanInput.people[].tasks`. The
actual upload-to-engine wiring (calling `/api/match` per protocol entry,
batching into `/api/plan`) is the next pass.

---

## Files added / changed in this pass

| Path | Status | Purpose |
| --- | --- | --- |
| `lib/engine/types.ts` | extended | Engine I/O types |
| `lib/engine/data.ts` | extended | Added `loadOperators()` |
| `lib/engine/ics.ts` | **new** | Tiny ICS parser + `nextMondayLocalIso()` |
| `lib/engine/duration.ts` | **new** | Task duration heuristic |
| `lib/engine/matcher.ts` | **new** | Reagent overlap + equipment batching |
| `lib/engine/compatibility.ts` | **new** | Waste-stream separations |
| `lib/engine/scheduler.ts` | **new** | Greedy interval scheduler |
| `lib/engine/impact.ts` | **new** | Week + annualized rollup |
| `lib/engine/index.ts` | **new** | `planWeek` orchestrator |
| `app/api/plan/route.ts` | **new** | POST endpoint |
| `scripts/test-engine.ts` | **new** | Smoke fixture |
| `components/HomeForm.tsx` | rewritten | Multi-protocol input per person |
| `app/results/tabs/PlanTab.tsx` | rewritten | Renders N protocols per card |
| `components/ResultsView.tsx` | extended | New `Submission` shape + count chips |

---

## Known limits (say these out loud in a code review)

- **Volume savings register as 0 at small sample counts.** This is correct
  math, not a bug — `prep_overhead_ml` from `overlap_rules.csv` (typically
  2–5 mL) exceeds the saved dead-volume waste (~0.2 mL) for a low-volume
  reagent shared across 2 small tasks. The win at small scale is
  `prep_events_saved`. Volume becomes the headline number when 3+ protocols
  share a high-volume reagent class (e.g. `ethanol_70_fresh` across multiple
  bead cleanups).
- **Equipment alignment is opportunistic, not enforced.** The greedy doesn't
  try to nudge start times to make `shared_equipment_run` coordinations
  align. In practice they only align when two tasks naturally landed at the
  same earliest slot. A second pass could fix this.
- **No cross-person family dependencies.** If person A runs DNA extraction
  and person B runs PCR using that DNA, the engine does NOT enforce A's
  extraction finishing before B's PCR. We chose this deliberately —
  cross-person dependencies need an explicit dependency graph the form
  doesn't yet collect.
- **ICS RRULE not expanded.** Recurring busy events from a real Google
  Calendar export will appear as a single instance. For the demo we expect
  the team's uploaded calendars to be flat.
- **Greedy scheduling is a heuristic.** Good for the demo's 4–8 task weeks;
  would need a proper CSP solver (OR-Tools) at 50+ tasks.

---

## What's next (Layer 4 + glue)

- **Wire `HomeForm` → API.** Per protocol entry: POST to `/api/match` (file
  upload) or `/api/hydrate` (dropdown pick). Collect all returned
  `EnrichedProtocol`s + the raw ICS text. POST the assembled bundle to
  `/api/plan`. Render the returned `WeekPlanResult` in `CoordinateTab`.
- **LLM narrator (Layer 4).** Replace each `Coordination.recommendation`
  string with prose generated by Gemini. Engine output stays the source of
  truth; the narrator only rephrases.
- **Calendar export (`lib/export/ics.ts`).** Take `WeekPlanResult.schedule`
  + each person's original busy ICS and emit per-operator `.ics` downloads
  for Page 3.
- **Demo data tuning.** Either add a 3rd bead cleanup for one of the
  operators (so `ethanol_70_fresh` overlaps across 2+ tasks and the README's
  "60 mL ethanol shared prep" headline materializes), or accept that the
  demo's primary value-prop is `prep_events_saved` rather than `volume_ml`.
