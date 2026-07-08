# LabSync — Bier Lab Pilot Presentation Brief

> **Instructions for Claude:** Turn this into a slide deck (PowerPoint / .pptx) of
> roughly 10–12 slides. The audience is **working scientists in the lab we're
> piloting with** (PI + grad students/postdocs), not investors — they already
> received a separate, business-oriented executive summary, so **do not repeat
> market-size / business-model / investor framing here.** This deck's job is to
> earn the trust of people who run these exact protocols every week, set up
> what they're about to watch, and be explicit about what's real vs. estimated.
> A **live demo on localhost immediately follows this deck**, so don't over-invest
> in screenshots or fake UI mockups — one or two simple diagrams are enough; the
> demo does the visual work. Tone: precise, calm, scientist-to-scientist. No
> hype language ("revolutionary," "game-changing," etc.). Where a number is
> a pilot estimate rather than a confirmed fact, say so on the slide, not just
> in speaker notes — this audience will ask about exactly that. Feel free to
> split or merge slides if it improves flow, but keep the ordering and honesty
> guardrails.

---

## Context (for Claude, not a slide)

**Product, one line:** "Any molecular-biology protocol PDF in, coordinated week
plan out." A labmate uploads a protocol PDF, an LLM extracts the reagents/
equipment/timing, the human confirms it, and then plain deterministic code
(no AI) schedules everyone's week and finds where people can share reagent
prep, batch equipment runs, and pool sequencing — without changing anyone's
actual protocol.

**This pilot:** the Bier Lab, UCSD (Drosophila / mosquito CRISPR gene-drive
lab, bierlab.weebly.com). Their published work (CopyCatchers, the 2024
single-allele-resolution mutation classifier, allelic-drive / malaria-vector
drives) all runs one genotyping loop: **extract gDNA → PCR the edited locus →
bead-clean amplicons → sequence.** The demo is built around real steps in
that exact loop, not a generic example, because that's what makes it land
with this audience.

---

## Slide-by-slide outline

### Slide 1 — Title
LabSync × [Bier Lab] Pilot
Subtitle: "Your protocols, coordinated — not redesigned."
Small footer: today's date, presenter name.

### Slide 2 — The problem, in their own words
Frame it as the lab's own week, not an abstract industry problem:
- A grad student runs DNA extraction Monday; a labmate runs PCR Tuesday and
  cleanup Wednesday — on the same underlying workflow, uncoordinated.
- Wash buffer / ethanol gets prepped separately, multiple times, for
  chemically identical steps.
- Equipment (thermocycler, magnetic plate) runs underfilled because nobody
  compared calendars.
- Samples trickle into sequencing one at a time instead of pooling into one
  flow cell run.
- Waste streams get combined or separated by habit, not by checking
  compatibility.
This is the cost of *coordination*, not the cost of *the science* — nobody
is proposing changing a single protocol step.

### Slide 3 — What LabSync does (one line + the flow)
"Any protocol PDF in, coordinated week plan out."
Simple left-to-right flow (this can be one diagram, not six slides):
Upload PDF → AI reads it into structured fields → **you confirm it** → plain
code schedules the week + finds overlaps → plain-English recommendations +
calendar export.
Emphasize: **protocols stay sacred.** The tool never proposes changing what
a protocol does — only when/how the prep and equipment around it happen.

### Slide 4 — Why you can trust the numbers (the design idea that matters)
This is the credibility slide for a scientific audience — lead with it before
they see any numbers.
- The AI (Claude) is used for exactly two things: reading messy protocol PDFs,
  and writing the plain-English explanation of a result. **It never does the
  arithmetic and never makes a chemistry-compatibility call.**
- All scheduling math and every "can these waste streams mix" decision is a
  **table lookup in deterministic code** — not a language model guessing.
- Nothing reaches the scheduler until a human (you) has reviewed and confirmed
  what the AI extracted from your PDF. That review step is the safety net.

### Slide 5 — Built around your actual workflow, not a generic demo
Show the four protocols we've loaded for this demo, mapped to their real role
in the Bier Lab's genotyping loop:
| Step | Protocol used in demo |
| --- | --- |
| DNA extraction | DNeasy 96 Blood & Tissue |
| Genotyping PCR | Q5 Hot Start High-Fidelity 2X Master Mix |
| Amplicon cleanup | Agencourt AMPure XP (96-well) |
| NGS library cleanup | MagJET NGS Cleanup Protocol A |
| **Headline: pooled sequencing** | UCSD IGM MiSeq i100 (self-service core) |
Note: coordination savings only appear when **two or more people run the
same protocol family in the same week** — this is why the demo scenario has
multiple labmates on overlapping work, and it's also the honest limit of what
the tool can do for a single person working alone.

### Slide 6 — What we'll show you live (demo roadmap)
Bullet list — this is the "here's what to watch for" slide right before
switching to localhost:
1. Upload protocols + calendars for a few labmates.
2. The confirmation step — you'll see exactly what the AI extracted and get
   to correct it before anything is scheduled.
3. The coordination view — top recommendation (a concrete shared prep or
   batched run), plus any "do not combine" warning for incompatible waste.
4. The impact summary for the week.
5. The exported `.ics` calendar files, ready to drop into your calendar app.

### Slide 7 — What "impact" means today (be exact)
This is the most important honesty slide in the deck. Present as two tiers:

**Actually computed by the engine, no estimation:**
- Reagent volume saved (the dead-volume overhead recovered by prepping once
  instead of N times — pooling doesn't reduce total reagent *consumed*, just
  the overhead of prepping it separately)
- Prep events avoided / equipment runs saved (from batching to capacity)
- Hazardous-disposal events avoided
- CO2e range for the above

**Grounded pilot estimates, not yet confirmed with your lab:**
- Grid electricity CO2e factor: EPA eGRID2023, CAMX (WECC California)
  subregion ≈ 0.195 kg CO2e/kWh — a real, cited figure, but a *regional*
  average, not your building's actual mix.
- MiSeq i100 energy: 300 W (Illumina's own i100 spec sheet — corrected from
  an earlier, wrong estimate based on the discontinued classic MiSeq), ~7.5 h
  for a 2×150bp pooled-amplicon run ≈ 2.25 kWh/run.
- Sequencing cost: UCSD IGM self-service recharge (~$300 internal /
  $435 external) + MiSeq reagent kit (~$1.7–2k, no public list price —
  estimated from comparable core facilities) ≈ **$1,900–2,300 all-in per run.**
- Reagent list prices (NEB, Beckman/Agencourt, QIAGEN) — public catalog
  prices, not your lab's negotiated PO prices.
- Some internal ranking coefficients (e.g. relative CO2e "cost" used to
  prioritize which recommendation to surface first) are still placeholder
  demo values, not lab-specific — they affect *which recommendation shows
  first*, not the headline reagent/run/CO2e numbers above.
Every one of these is labeled "pilot estimate — confirm with lab" in the
product itself, not just in this deck.

### Slide 8 — What we need from you during the pilot
Frame this as a collaboration ask, not a list of gaps:
- Your actual instrument inventory (thermocyclers, any liquid handler/
  in-house sequencer) — right now the equipment catalog is a placeholder lab.
- Your real sequencing provider, price list, and per-run capacity (we've
  assumed UCSD IGM MiSeq i100 self-service).
- Your negotiated reagent prices, where different from public list prices.
- How often you actually run each of these protocols, so annualized savings
  reflect your real throughput, not a flat weekly assumption.
- Rough minutes-per-prep and minutes-per-instrument-setup, so we can report
  time saved, not just materials saved.

### Slide 9 — Guardrails we hold ourselves to
- We only ever surface a recommendation the engine actually computed —
  no invented numbers, ever.
- Every equipment coordination is checked against your team's actual
  calendars before we call it "aligned."
- Every waste-stream separation warning is a lookup against a curated
  compatibility table (grounded in EH&S-style pairwise rules), not the AI's
  judgment call.
- Anything not yet confirmed with your lab is labeled as an estimate, both
  in this deck and in the product UI.

### Slide 10 — What success looks like for this pilot
- Confirm the coordination math against a real week of your team's work.
- Replace the estimated figures on Slide 7 with your actual numbers.
- Decide whether to extend the protocol library beyond this genotyping loop
  to the rest of your workflows.

### Slide 11 — Now let's look at it live
Transition slide: "Switching to localhost — [operator names/protocols used
in the live run]." Keep it to one line; this is the handoff slide.

### Slide 12 — Questions / contact
Presenter contact info, and an open invitation to poke at edge cases live.

---

## Appendix — numbers to keep verbatim if quoted (for Claude)

- Grid factor: **0.195 kg CO2e/kWh**, EPA eGRID2023 CAMX subregion
  (https://www.epa.gov/egrid/summary-data).
- MiSeq i100 power: **300 W max** (Illumina spec sheet + NRTL safety cert;
  supersedes an earlier, incorrect 400 W figure that was actually the
  discontinued classic MiSeq's spec).
- MiSeq i100 pooled-amplicon run time: **~450 min (~7.5 h)** for a 2×150bp
  kit → **~2.25 kWh/run**.
- UCSD IGM MiSeq i100 recharge: **$300 internal / $435 external**, reagents
  not included.
- All-in estimated cost per pooled MiSeq run: **~$1,900–2,300**.
- Reagent list prices used for costing: NEB Q5 HS 2X ($264/100 rxn,
  $1,048/500 rxn), Beckman AMPure XP (~$19–30/mL depending on pack size),
  QIAGEN DNeasy Blood & Tissue 250-prep (~$990–1,500).

Do not round these into vaguer marketing numbers — the whole point of this
deck is that a scientific audience can trace every figure back to a source.
