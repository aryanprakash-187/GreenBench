# Remaining Work — Items 1, 2, 6 (Cost / Energy Overlay)

Status after the catalog-path cleanup: the dead code is gone, tests are rebuilt
on the live `parse -> resolveDraft -> planWeek` path, and everything typechecks
green. What remains from the correction plan is the **cost/energy overlay**.
Items 3 (reagent cost + kit model), 4 (time-saved), and 5 (folded into cleanup)
are still pending your approval and are NOT covered here.

This is a plan only — **not implemented yet.**

---

## Context: what the engine outputs today

`impact.rollupImpact()` (`lib/engine/impact.ts`) sums, over aligned coordinations
only:
- `reagent_volume_saved_ml`
- `prep_events_saved`
- `equipment_runs_saved`
- `estimated_co2e_kg_range` (reagent volume only)
- `hazardous_disposal_events_avoided`

No dollars, no kWh. Per-coordination savings live on `CoordinationSavings`
(`lib/engine/types.ts`) and are computed in `lib/engine/matcher.ts`.

### Demo finding that motivates this work

Running the 3-person demo scenario (Aryan/Sohini/Vikas, each a Q5 PCR + AMPure
cleanup) at **24 samples** produced:
- `equipment_runs_saved = 4` (thermocycler batch of 3 + magnetic-separator batch of 3)
- `prep_events_saved = 10`
- `reagent_volume_saved_ml ≈ 0.5`, `co2e ≈ 0`

i.e. at low sample counts the **mL and CO2e headline numbers are ~0** — the real,
visible wins are *run counts* and *prep events*. Attaching **dollars per run**
turns `equipment_runs_saved = 4` into a concrete figure, which is exactly what the
demo needs. (Raising sample counts to 300–600 also makes mL/CO2e visible.)

---

## Item 1 — Ground energy (kWh) and energy-CO2e

**Goal:** compute real kWh and CO2e for each aligned `shared_equipment_run`, off
data we already have, instead of the mock `equipment_energy` block.

**Math:**
- `kwh_per_run = power_draw_kw_active × run_duration_hours` — `power_draw_kw_active`
  is already in `data/seed/equipment.csv`; run duration from the instrument's
  typical run time (add a `run_duration_min` column, or reuse the task duration).
- `kwh_saved = runs_saved × kwh_per_run`
- `energy_co2e_kg = kwh_saved × grid_factor`, where **grid_factor = 0.195 kg
  CO2e/kWh** (EPA eGRID CAMX / WECC California, 2023 vintage).
- Electricity dollars are optional/small; can add `× electricity_$per_kwh`
  (CA ≈ $0.25/kWh) if we want an energy-cost line.

**Files:**
- `lib/engine/matcher.ts` (`buildEquipmentCoordinations`): compute `kwh_saved` and
  `energy_co2e_kg` per coordination; add to its `savings`.
- `lib/engine/types.ts` (`CoordinationSavings`, `ImpactWeekly`): add `kwh_saved`
  and fold energy CO2e into the CO2e range (or a separate `energy_co2e_kg_range`).
- `lib/engine/impact.ts` (`rollupImpact`): sum `kwh_saved` weekly + ×52.
- `data/impact_coefficients.json`: replace the mock `grid_co2e_kg_per_kwh` with
  0.195 and mark the source; the mock `equipment_energy.cycle_kwh_per_run` block
  becomes derived (power × duration) rather than hardcoded.

**Note:** MiSeq nameplate = 400 W ([Illumina spec]), a ~24 h run ≈ 9.6 kWh; the
Bio-Rad C1000 at 0.85 kW over ~2 h ≈ 1.7 kWh. Instrument electricity CO2e is
small (~2–4 kg/run); the dollar-per-run (Item 2) is the bigger story.

---

## Item 2 — UCSD IGM MiSeq i100 sequencer + per-run dollars

**Goal:** show "consolidated N partial sequencing runs into 1, saving $X" as a
real engine output.

**Seed data:**
- Add a sequencer row to `data/seed/equipment.csv`: id `miseq-i100-1`, type
  `sequencer`, model `Illumina MiSeq i100 (UCSD IGM)`, capacity = pooled amplicon
  indices per run (assumption, e.g. 96–384), plus new columns `cost_per_run_usd`
  and `run_duration_min`.
- Cost assumption (label as pilot estimate): **~$1,900–2,300 all-in** = $300 IGM
  recharge + ~$1.6–2k MiSeq reagent kit. (Provider = UCSD IGM core; platform =
  MiSeq i100.)

**Design decision — how the pooled-sequencing coordination enters a live-upload
pipeline (needs confirmation before building):** the sequencing run is a
lab-level downstream step, not something in any single cleanup/PCR PDF. Two ways
to materialize it:

- **(A) Derived coordination (recommended):** add
  `buildSequencingCoordinations(people)` in the engine that groups
  `Bead_cleanup` (amplicon/library-prep) tasks across people the same week and
  emits a `shared_equipment_run` on `sequencer` with
  `runs_saved = participants - 1` and `usd_saved = runs_saved × cost_per_run_usd`.
  Alignment reuses the scheduler's existing start-time check on those cleanup
  tasks. Assumption baked in: "a cleanup this week implies a sequencing
  submission." Watch for interaction with the existing magnetic_separator
  coordination over the same tasks (don't double-count as equipment peers).
- **(B) Explicit equipment hint:** teach the parser/`resolveDraft` to recognize a
  sequencer in a protocol's equipment and let it batch like any instrument. Only
  fires if the uploaded PDF names a sequencer — fragile for cleanup/PCR PDFs.

**Wiring (either way):**
- `CoordinationSavings` + `ImpactWeekly`: add `usd_saved`.
- `impact.rollupImpact`: sum `usd_saved` weekly + ×52.

---

## Item 6 — Label everything as pilot estimates

**Goal:** every $ / kWh / CO2e figure in the UI is clearly a mock/pilot estimate,
so we don't overstate precision to the Bier Lab.

**Files:**
- `components/OverviewPage.tsx` (`ImpactSummarySection` / `buildSavingsChips`): add
  a persistent "pilot estimate — confirm with lab" caption/badge next to any
  dollar, kWh, or CO2e number.
- Keep physical-count metrics (mL, prep events, run counts, hazardous-disposal
  events) unlabeled — those are computed, not assumed.

---

## Dependencies / open questions before implementing

1. **Item 2 modeling:** confirm approach (A) derived coordination vs (B) explicit
   hint, and the assumption that any `Bead_cleanup` implies a sequencing run.
2. **Sequencer capacity** (indices per pooled run) and **cost_per_run** value to
   seed.
3. Whether to include an **electricity-cost line** (Item 1) or keep energy to
   kWh + CO2e only.

## Suggested build order

1. Item 1 (energy) — self-contained, unblocks the impact/UI plumbing.
2. Item 6 (labels) — depends on numbers being displayed.
3. Item 2 (sequencing $) — after confirming the modeling decision above.

## Verify after building

- `npx tsc --noEmit`
- `npm run engine:test` (assert new `kwh_saved` / `usd_saved` are non-zero and
  roll up correctly)
- `npm run narrate:test`
