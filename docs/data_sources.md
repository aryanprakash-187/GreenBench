# BenchGreen data sources and modeling notes

This bundle was rebuilt conservatively from the uploaded vendor manuals and the project handoff docs.

Where a manual gave an exact value, that value was used directly.
Where a manual gave a range or a variable placeholder, the bundle either:
1. set a documented default in the CSV `notes` column, or
2. set the quantitative value to `0` when the field is sample-specific and should not drive shared-prep savings.

## Selected protocol sources

### DNA extraction
- **DNeasy Blood & Tissue (animal tissues, spin-column)**  
  Source basis:
  - tissue protocol starts with `180 µL Buffer ATL`, then `20 µL Proteinase K`, then `200 µL Buffer AL + 200 µL ethanol`, then `500 µL Buffer AW1`, `500 µL Buffer AW2`, and `200 µL Buffer AE`.
- **GeneJET Genomic DNA Purification Kit (cultured mammalian cells)**  
  Source basis:
  - `200 µL Lysis Solution`
  - `20 µL Proteinase K Solution`
  - `20 µL RNase A Solution`
  - `400 µL 50% ethanol`
  - `500 µL Wash Buffer I`
  - `500 µL Wash Buffer II`
  - `200 µL Elution Buffer`
- **MagJET Genomic DNA Kit (manual cultured mammalian cells)**  
  Source basis:
  - `40 µL 0.15 M NaCl solution`
  - `200 µL Digestion Solution`
  - `20 µL Proteinase K Solution`
  - `20 µL RNase A Solution`
  - `300 µL Lysis Buffer`
  - `400 µL isopropanol`
  - `25 µL magnetic beads suspension`
  - `800 µL Wash Buffer 1`
  - `800 µL Wash Buffer 2` twice
  - `150 µL Elution Buffer`

### PCR
- **Q5 Hot Start High-Fidelity 2X Master Mix (50 µL reaction)**  
  Source basis:
  - `25 µL master mix`
  - `2.5 µL` each 10 µM forward/reverse primer
  - nuclease-free water `to 50 µL`
  - template DNA is variable  
  Modeling rule:
  - `Template DNA` is set to `0 µL` in `protocol_reagents.csv` because it is sample-specific and should not be counted in shared-prep volume.
  - `Nuclease-Free Water` is modeled as `20 µL` to represent common-prep volume exclusive of template input.
- **Platinum II Hot-Start PCR Master Mix (2X), 50 µL reaction**  
  Source basis:
  - `25 µL master mix`
  - `1 µL` each 10 µM forward/reverse primer
  - `10 µL Platinum GC Enhancer` optional
  - water `to 50 µL`
  - template DNA variable  
  Modeling rule:
  - `Template DNA = 0 µL`, `GC Enhancer = 0 µL` by default.
  - `Water, nuclease-free = 23 µL` as common-prep default.
- **JumpStart REDTaq ReadyMix Reaction Mix (50 µL reaction)**  
  Source basis:
  - `25 µL JumpStart REDTaq ReadyMix`
  - primers at `0.4 µM final` from 20 µM stocks → modeled as `1 µL` each
  - water `q.s. to 50 µL`
  - template DNA variable
  - mineral oil optional  
  Modeling rule:
  - `Template DNA = 0 µL`
  - `PCR Reagent water = 23 µL`
  - optional additives (`Mineral Oil`, `Betaine`, `DMSO`) are included as `0 µL` default rows

### Bead cleanup
- **Agencourt AMPure XP PCR Purification (96-well, 50 µL PCR sample)**  
  Source basis:
  - AMPure XP volume is `1.8 × sample volume` → `90 µL` for a 50 µL PCR sample
  - `200 µL` 70% ethanol wash, repeated twice
  - `40 µL` elution buffer
- **MagJET NGS Cleanup and Size Selection Kit (Cleanup Protocol / Duo-Flex table)**  
  Source basis:
  - `5 µL MagJET Magnetic Beads`
  - `700 µL Binding Mix`
  - `100 µL DNA sample`
  - `400 µL Wash Solution` twice
  - `50 µL Elution Buffer`
  Modeling rule:
  - `DNA sample` is not represented as a reagent row because it is the input material, not a shared reagent.
- **AxyPrep Mag PCR Clean-up (96-well, 50 µL PCR sample modeled from 1.8× formula)**  
  Source basis:
  - protocol gives explicit `1.8 × PCR volume` bead ratio
  - detailed wash/elution page gives `200 µL` 70% ethanol wash twice and `40 µL` elution buffer
  Modeling rule:
  - for seeded workflow consistency, a `50 µL` PCR cleanup default is used, giving `90 µL` bead reagent.

## Thermal-profile modeling
- **Q5**: manufacturer gives ranges rather than one default annealing temperature / extension duration.  
  Bundle default: `60°C` annealing, `20 s`, `30 s/kb` extension, `30 cycles`.  
  This is a *modeled routine short-amplicon default*, not a universal manufacturer default.
- **Platinum II**: manufacturer provides `94°C 2 min`, then `94°C 15 s`, `60°C 15 s`, `68°C 15 s/kb`, with no separate final extension in the example routine table.  
  Bundle sets `final_extension_time_s = 0`.
- **JumpStart**: manufacturer provides `55–68°C` annealing and `30–35` cycles.  
  Bundle default: `60°C`, `30 cycles`.

## EPA cache strategy
The handoff allows classification by analogy when a clean EPA hit does not exist.
This cache therefore uses:
- **broad waste/hazard buckets** keyed by `epa_lookup_key`
- **component-based or analogy-based classification** for proprietary buffers
- **explicit note fields** when a value is a screening class rather than a direct chemical record

## Impact coefficients
These are hackathon-grade low/mid/high ranges for ranking recommendations.
They are not publication-grade LCA numbers.
