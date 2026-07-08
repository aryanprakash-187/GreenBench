# Bier Lab Pilot Demo — Conclusions & Action Points

Working notes for the LabSync pilot at the **Bier Lab, UCSD** (Drosophila /
mosquito CRISPR gene-drive lab, [bierlab.weebly.com](https://bierlab.weebly.com/)).
This file records the decisions and reasoning from the demo-planning conversation
so the next person (or model) inherits the context. It is deliberately terse.

---

## 1. What the demo is about

"Any molecular-biology protocol PDF in, coordinated week plan out." For the pilot
we show that when several labmates run related protocols the same week, LabSync
coordinates shared reagent prep, shared instrument runs, and (the headline) a
**pooled sequencing run**, and reports the savings.

## 2. Protocols chosen (grounded in their publications)

The Bier Lab's papers (CopyCatchers, the 2024 single-allele-resolution mutation
classifier, allelic-drive / malaria-vector drives) all run one genotyping loop:

```
extract fly/mosquito gDNA -> PCR the edited locus -> bead-clean amplicons -> sequence
```

Demo protocols (all real steps in that loop):

1. **DNeasy 96 Blood & Tissue** — gDNA extraction (family `DNA_extraction`)
2. **Q5 Hot Start High-Fidelity 2X Master Mix** — genotyping PCR (family `PCR`)
3. **Agencourt AMPure XP (96-well)** — amplicon cleanup (family `Bead_cleanup`)
4. **MagJET NGS Cleanup Protocol A** — amplicon-NGS library cleanup (family `Bead_cleanup`)

**Key engine constraint:** savings only appear when **2+ people run the same
protocol family** with the **same overlap group / equipment group**
(`matcher.ts` keys on `family::group`). A single person doing extract -> PCR ->
cleanup yields zero cross-person savings. The demo scenario must put multiple
labmates on the same family in the same week.

## 3. How savings are computed today (real state)

- Engine is pure code in `lib/engine/`. `matcher.ts` finds opportunities,
  `scheduler.ts` places tasks and flips `aligned`, `impact.ts` rolls up **only
  aligned** coordinations.
- Two coordination types: `shared_reagent_prep` and `shared_equipment_run`.
- Headline units today: **reagent mL saved, prep events saved, equipment runs
  saved, CO2e kg range, hazardous-disposal events avoided.** Each with a naive
  weekly x52 annualization.
- **No dollars and no kWh are computed today.** The `hazardous_disposal_cost_usd`
  field exists on enriched reagents but is never summed; the `equipment_energy`
  block in `data/impact_coefficients.json` is never read by any engine file.
- Reagent volume "saved" is only the **dead-volume overhead** recovered by
  prepping once (`savedMl = sum(per-task dead volume) - prep_overhead_ml`), not
  total reagent — pooling does not reduce how much reagent you consume.

## 4. Cost / CO2e / energy — where the numbers come from

Current coefficients in `data/impact_coefficients.json` are **mock** (the file
says so). Real, citable sources to replace them:

- **Grid CO2e:** EPA eGRID subregion **CAMX (WECC California) = 429.98 lb
  CO2e/MWh ≈ 0.195 kg CO2e/kWh**
  ([EPA eGRID2023 summary](https://www.epa.gov/egrid/summary-data);
  Climatiq lists ~0.226 for the 2022 vintage:
  [link](https://www.climatiq.io/data/emission-factor/05daafd3-f044-4d78-a27c-dd8992a856bd)).
- **Energy per run = nameplate power (kW) × run duration (h).** Specs already in
  `data/seed/equipment.csv` (`power_draw_kw_active`). **Correction:** the 400 W
  figure previously here was sourced from the site-prep guide/datasheet for the
  older, discontinued **classic MiSeq** — not the **MiSeq i100** actually seeded
  in this app. The i100's own spec sheet and NRTL safety certificate both give
  **300 W maximum**:
  ([MiSeq i100 spec sheet](https://emea.illumina.com/content/dam/illumina/gcs/assembled-assets/marketing-literature/miseq-i100-specification-sheet-m-gl-02244/miseq-i100-specification-sheet-m-gl-02244.pdf),
  [electrical requirements](https://support-docs.illumina.com/IN/MiSeqi100Series/Content/IN/MiSeqi100/ElecReqs.htm)).
  Run time is kit-dependent, not a flat 24 h: the same spec sheet's run-time
  table shows ~4–5 h for the shortest kit, **~7–8 h for the 2×150bp kit typical
  of pooled amplicon/16S work** (what this app models), up to ~24 h only for the
  longest 2×500bp kit. At 300 W × ~7.5 h ≈ **2.25 kWh** per run — smaller than
  the earlier 9.6 kWh estimate. Instrument electricity CO2e is correspondingly
  small (~0.4 kg/run at the 0.195 kg CO2e/kWh grid factor); the dollar-per-run
  is still the real story.

### Sequencing (the headline) — provider decision: **UCSD IGM MiSeq i100**

- **UCSD IGM / Moores core recharge: MiSeq run = $300 internal / $435 external,
  reagents NOT included**
  ([Moores Genomics recharge rates](https://moorescancercenter.ucsd.edu/research/shared-resources/genomics-bioinformatics/index.html);
  [IGM Rates 2025 PDF](https://igm.ucsd.edu/sites/default/files/docs/IGM%20Rates%202025%20New%20IDC.pdf)).
  They run the **MiSeq i100** self-service
  ([IGM MiSeq i100](https://igm.ucsd.edu/genomics/miseqselfservice)).
- **MiSeq v3 600-cycle reagent kit (MS-102-3003): no public list price** (Illumina
  requires sign-in). Observed core prices: URI **$1,655**
  ([URI MIC](https://web.uri.edu/riinbre/mic/mic-services-and-resources/mic-sequencing-services/mic-miseq/));
  Columbia **$2,000 internal / $2,600 external**
  ([CU price sheet](https://content.ilabsolutions.com/wp-content/uploads/2016/03/CU-Price-sheet-March2016.pdf)).
- **All-in a full MiSeq run ≈ $300 recharge + ~$1.6–2k kit ≈ $1,900–2,300.**
- Provider vs platform: **platform** = the machine (MiSeq/NovaSeq/Sanger);
  **provider** = who runs it and sets your price (UCSD IGM core here). We model
  the pair.

### Reagent list prices (public, for the cost table)

- NEB Q5 HS 2X Master Mix: **$264 / 100 rxn** vs **$1,048 / 500 rxn**
  ([NEB M0494](https://www.neb.com/en-us/products/m0494-q5-hot-start-high-fidelity-2x-master-mix)).
- Beckman AMPure XP: **$1,816–2,144 / 60 mL** (~$30/mL), **~$8,700 / 450 mL** (~$19/mL)
  ([Beckman A63881](https://www.mybeckman.ca/reagents/genomic/cleanup-and-size-selection/pcr/a63881),
  [Fisher](https://www.fishersci.com/shop/products/ampure-xp-60ml/NC9933872)).
- QIAGEN DNeasy Blood & Tissue (250): **~$990–1,500**
  ([UofT medstore](https://www.uoftmedstore.com/item_detail.sz?id=33328&parent=12922)).

These are **list** prices; the lab's negotiated PO prices differ — seed list now,
let the lab correct during the pilot.

## 5. Sourcing strategy for cost data

- **Manual curated CSVs now** (correct for a pilot; ~30–40 line items).
- Long-term, better than a generic scraper (most vendor prices are sign-in gated):
  a small admin edit screen, importing the lab's **purchasing/PO export**, and
  public **core-facility price lists** for sequencing. Opportunistic scraping only
  for vendors that publish openly (e.g. NEB).

## 6. The kit / bottle-minimum reagent savings model (PROPOSED — not built)

Pooling does not reduce reagent consumed, so the money comes from:

1. **Dead-volume overhead** (already modeled, small).
2. **Discrete pack sizes + bulk tiers** (the real story): e.g. Q5 at $2.64/rxn
   (100-pack) vs $2.10/rxn (500-pack). 3 labmates each needing ~96 rxns:
   uncoordinated = 3 × $264 = **$792** (three partial packs); coordinated = one
   500-pack = **$605** for the 288 rxns used → **~$187 saved/week**, plus no
   fragmented perishable stock. Same logic as sequencing fill-rate, applied to
   packaging. Needs pack-size + tier-price data (Action 3).

## 7. Prep time / time-saved (PROPOSED — not built)

`duration.ts` models task wall-clock only; there is **no reagent-prep-time** and
no time on `shared_reagent_prep`. To report time saved (no dollar attached):
`time_saved = prep_events_saved × prep_min + runs_saved × setup_min`, where the
minutes are **assumptions to confirm with the lab** (can't be derived from PDFs).

## 8. Codebase finding: two parallel pipelines; catalog path is dead

There are two pipelines; only one is the live product:

- **LIVE (keep):** upload PDF -> `/api/parse` (`parseProtocol.ts`) -> `DraftProtocol`
  (LLM-extracted volumes) -> user confirms in `ProtocolDraftReview` -> `/api/plan`
  (`resolveDraft` + `planWeek` + narrate) -> `/api/export`.
- **CATALOG (hackathon leftover — REMOVE):** dropdown/filename -> `/api/match`
  or `/api/hydrate` -> `matchProtocol.ts` three-tier matcher -> `hydrateProtocol`
  reads hardcoded volumes from `protocol_reagents.csv`.

**Volume-model correction:** the live path uses the **LLM's** extracted volumes
(user-overridable; null -> 0 + `missing_information`). It does **not** fall back
to `protocol_reagents.csv`. The hardcoded volumes were hackathon-era distrust of
the LLM and are dead in the real workflow. Live parse also already treats
`protocol_name` as **free text**; the closed 14-name enum lives only in the dead
match schema.

### Dead code inventory (approved for removal)

| Item | Used only by | Action |
| --- | --- | --- |
| `app/api/match/route.ts` | nothing in frontend | delete |
| `app/api/hydrate/route.ts` | nothing in frontend | delete |
| `lib/engine/hydrate.ts` | match/hydrate routes + test scripts | delete |
| `lib/llm/matchProtocol.ts` (~900 lines) + `prompts/matchProtocol.md` | match route + test | delete |
| `data/seed/protocol_reagents.csv` (hardcoded volumes) | hydrate only | delete |
| `data/seed/protocol_thermal_profiles.csv` | hydrate only (live gets thermal from LLM) | delete |
| `data/seed/protocol_equipment_requirements.csv` | hydrate only (live gets equip from `resolveDraft`+`equipment.csv`) | delete |
| `lab catalog/` (top-level) | nothing — code reads `data/seed` only | delete |
| `scripts/test-engine.ts`, `test-narrate.ts`, `test-llm-layer.ts` | use hydrate/matchProtocol | rewrite onto parse/resolveDraft or drop |
| schema/data/types code for the above | — | surgery, keep `protocols_selected.csv` + `loadProtocols` (used by `seedDataVersion`) |

## 9. Action points

| # | Action | Status |
| --- | --- | --- |
| 0 | Remove dead catalog path (Section 8) | approved — in progress |
| 1 | Ground energy/CO2e: `kWh = power × duration`, grid = eGRID CAMX 0.195; wire into `impact.ts` | approved (1/2/6) |
| 2 | Add UCSD IGM **MiSeq i100** sequencer + per-run cost; wire `runs_saved -> usd_saved` | approved (1/2/6) |
| 3 | Reagent cost + kit-packaging model (Section 6) | pending approval |
| 4 | Time-saved from duration model (Section 7), no dollar | pending approval |
| 5 | (folded into 0) fix docs/mental-model: two volume paths; thermocycler exists | pending approval |
| 6 | Label all $/kWh/CO2e figures "pilot estimate — confirm with lab" in UI | approved (1/2/6) |

## 10. To confirm with the lab during the pilot

- Their actual thermocyclers and whether they own any liquid handler / sequencer.
- Sequencing provider + price list + run capacity (assumed: UCSD IGM MiSeq i100).
- Real negotiated reagent prices (seed with list prices for now).
- Per-protocol **throughput/frequency** (makes the x52 annualization honest).
- Minutes per reagent prep and per instrument run setup (for time-saved).

## 11. Guardrails for the live demo

- Only quote metrics the engine actually computed; label every $/kWh/CO2e as a
  pilot estimate (coefficients are mock until the lab confirms).
- Equipment batching depends on calendar alignment — verify `aligned=true` before
  the demo; don't claim the scheduler "optimizes" (it greedily aligns peers).
- We have a thermocycler in the catalog (`thermo-c1000-a`, Bio-Rad C1000, cap 96);
  PCR is the batchable step (same thermal profile, combined ≤ capacity).
