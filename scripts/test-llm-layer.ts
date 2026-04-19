// End-to-end smoke test for the LLM layer.
//
// What it covers:
//   1. Every one of the 9 seed protocols can be matched from a typical filename
//      (deterministic tiers only — LLM is disabled here so the test is offline-safe).
//   2. Every matched protocol hydrates without throwing.
//   3. Hydrated reagents have non-zero total volumes (sample_count multiplication
//      actually happened) and have an EPA hazard summary attached when the seed
//      data implies one.
//   4. PCR protocols carry a thermal_profile; non-PCR protocols don't.
//
// Run:  npx tsx scripts/test-llm-layer.ts
// Run with LLM tier exercised:  npx tsx scripts/test-llm-layer.ts --llm

import { matchProtocol } from '../lib/llm/matchProtocol';
import { hydrateProtocol } from '../lib/engine/hydrate';
import { loadProtocols } from '../lib/engine/data';

const FIXTURES: Array<{ filename: string; expected: string; samples: number }> = [
  { filename: 'DNeasy_Blood_and_Tissue_Handbook.pdf',                  expected: 'DNeasy Blood & Tissue', samples: 8 },
  { filename: 'GeneJET-Genomic-DNA-Purification-Kit-K0721-manual.pdf', expected: 'GeneJET Genomic DNA Purification Kit', samples: 8 },
  { filename: 'MagJET-Genomic-DNA-Kit_protocol.pdf',                   expected: 'MagJET Genomic DNA Kit', samples: 4 },
  { filename: 'Q5_HotStart_HiFi_2X_MasterMix_M0494_neb.pdf',           expected: 'Q5 Hot Start High-Fidelity 2X Master Mix', samples: 12 },
  { filename: 'PlatinumII_HotStart_PCR_2X_Invitrogen.pdf',             expected: 'Platinum II Hot-Start PCR Master Mix (2X)', samples: 12 },
  { filename: 'JumpStart-REDTaq-ReadyMix-Sigma-P0982.pdf',             expected: 'JumpStart REDTaq ReadyMix Reaction Mix', samples: 12 },
  { filename: 'Agencourt_AMPure_XP_PCR_Purification_A63881.pdf',       expected: 'Agencourt AMPure XP PCR Purification', samples: 12 },
  { filename: 'MagJET_NGS_Cleanup_Size_Selection_K2821.pdf',           expected: 'MagJET NGS Cleanup and Size Selection Kit', samples: 12 },
  { filename: 'AxyPrep_Mag_PCR_CleanUp_Axygen.pdf',                    expected: 'AxyPrep Mag PCR Clean-up', samples: 12 },
];

interface Failure {
  filename: string;
  reason: string;
}

async function main() {
  const useLlm = process.argv.includes('--llm');
  const failures: Failure[] = [];
  let passed = 0;

  console.log(`Loaded ${loadProtocols().length} curated protocols.`);
  console.log(`LLM tier: ${useLlm ? 'ENABLED' : 'disabled (filename + keyword tiers only)'}`);
  console.log('');

  for (const fix of FIXTURES) {
    const match = await matchProtocol({
      filename: fix.filename,
      disable_llm: !useLlm,
    });

    if (match.protocol_name !== fix.expected) {
      failures.push({
        filename: fix.filename,
        reason: `expected "${fix.expected}", got "${match.protocol_name}" (matched_via=${match.matched_via}, confidence=${match.confidence.toFixed(2)})`,
      });
      console.log(`  FAIL  ${fix.filename}`);
      console.log(`        expected: ${fix.expected}`);
      console.log(`        got:      ${match.protocol_name ?? '(none)'} via ${match.matched_via} @ ${match.confidence.toFixed(2)}`);
      continue;
    }

    let enriched;
    try {
      enriched = hydrateProtocol({
        protocol_name: match.protocol_name,
        sample_count: fix.samples,
        matched_via: match.matched_via === 'none' ? 'manual' : match.matched_via,
      });
    } catch (err) {
      failures.push({
        filename: fix.filename,
        reason: `hydration threw: ${(err as Error).message}`,
      });
      continue;
    }

    // Sanity checks
    const issues: string[] = [];
    const reagentsWithVolume = enriched.reagents.filter((r) => r.volume_total_ul > 0);
    if (reagentsWithVolume.length === 0) {
      issues.push('no reagents had non-zero total volume after sample_count multiplication');
    }
    const reagentsWithHazard = enriched.reagents.filter((r) => r.hazard !== null);
    if (reagentsWithHazard.length === 0) {
      issues.push('no reagents resolved an EPA hazard summary');
    }
    const isPcr = enriched.family === 'PCR';
    if (isPcr && !enriched.thermal_profile) {
      issues.push('PCR protocol is missing a thermal_profile');
    }
    if (!isPcr && enriched.thermal_profile) {
      issues.push('non-PCR protocol unexpectedly has a thermal_profile');
    }

    if (issues.length > 0) {
      failures.push({
        filename: fix.filename,
        reason: `hydration completed but: ${issues.join('; ')}`,
      });
      continue;
    }

    passed++;
    const samplesShown = `${fix.samples}sa`;
    const reagentBudgetMl =
      enriched.reagents.reduce((acc, r) => acc + r.volume_total_ul, 0) / 1000;
    console.log(
      `  ok    ${fix.filename}\n        -> ${enriched.protocol_name} (${samplesShown}, ${enriched.reagents.length} reagents, ${reagentBudgetMl.toFixed(2)} mL total)`
    );
  }

  console.log('');
  console.log(`Result: ${passed}/${FIXTURES.length} passed`);
  if (failures.length > 0) {
    console.log('');
    console.log('Failures:');
    for (const f of failures) {
      console.log(`  - ${f.filename}: ${f.reason}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
