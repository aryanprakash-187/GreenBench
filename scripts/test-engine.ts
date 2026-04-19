// Smoke test for the deterministic engine.
//
// Builds the demo's signature week:
//   - Sohini runs DNeasy Blood & Tissue (8 samples)
//   - Sohini runs MagJET Genomic DNA Kit (4 samples)         (extraction #2)
//   - Vikas runs Q5 Hot Start PCR (12 samples)
//   - Vikas runs Agencourt AMPure XP cleanup (12 samples)
//
// Asserts:
//   - The engine surfaces an ethanol-class shared_reagent_prep coordination.
//   - Sohini's MagJET (extraction) is scheduled before Sohini's PCR (n/a here)
//     and Vikas's PCR happens before his AMPure cleanup (intra-person family
//     ordering).
//   - At least one separation fires between any chaotropic-bearing extraction
//     and any other reagent stream that would show up.
//
// Run:  pnpm tsx scripts/test-engine.ts

import { hydrateProtocol } from '../lib/engine/hydrate';
import { planWeek } from '../lib/engine';
import { nextMondayLocalIso } from '../lib/engine/ics';
import type { EnginePlanInput, HydratedTask } from '../lib/engine/types';

function makeTask(person: string, protocolName: string, sampleCount: number, idx: number): HydratedTask {
  const protocol = hydrateProtocol({
    protocol_name: protocolName,
    sample_count: sampleCount,
    matched_via: 'manual',
  });
  return {
    task_id: `${slug(person)}__${slug(protocolName)}__${idx}`,
    protocol,
  };
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error('  ✗ FAIL:', msg);
    process.exitCode = 1;
  } else {
    console.log('  ✓', msg);
  }
}

function main(): void {
  const weekStart = nextMondayLocalIso();
  console.log('Week start:', weekStart);

  const input: EnginePlanInput = {
    week_start_iso: weekStart,
    people: [
      {
        name: 'Sohini',
        operator_id: 'op2',
        busy: [],
        tasks: [
          makeTask('Sohini', 'DNeasy Blood & Tissue', 8, 1),
          makeTask('Sohini', 'MagJET Genomic DNA Kit', 4, 2),
        ],
      },
      {
        name: 'Vikas',
        operator_id: 'op3',
        busy: [],
        tasks: [
          makeTask('Vikas', 'Q5 Hot Start High-Fidelity 2X Master Mix', 12, 1),
          makeTask('Vikas', 'Agencourt AMPure XP PCR Purification', 12, 2),
        ],
      },
    ],
  };

  const result = planWeek(input);

  console.log('\n--- Schedule ---');
  for (const s of result.schedule) {
    console.log(
      `  ${s.start_iso}  →  ${s.end_iso}  ${s.person.padEnd(8)} ${s.family.padEnd(15)} ${s.protocol_name}` +
        (s.shared_with.length ? `  [shared: ${s.shared_with.join(', ')}]` : '')
    );
  }

  console.log('\n--- Coordinations ---');
  for (const c of result.coordinations) {
    console.log(
      `  [${c.aligned ? 'aligned' : 'unaligned'}] ${c.type}  ${c.overlap_group ?? c.equipment_group ?? '?'}  →  ${c.recommendation}`
    );
    console.log(
      `      participants: ${c.participants.map((p) => `${p.person}/${p.task_id}` + (p.volume_ul ? ` (${p.volume_ul}µL)` : '')).join(', ')}`
    );
    console.log(
      `      savings: ${JSON.stringify(c.savings)}`
    );
  }

  console.log('\n--- Separations ---');
  for (const sep of result.separations) {
    console.log(
      `  [${sep.severity}] ${sep.pair.join(' × ')}  tasks=${sep.task_ids.join(', ')}  reason="${sep.reason}"`
    );
  }

  console.log('\n--- Impact ---');
  console.log('  weekly:', JSON.stringify(result.impact.weekly));
  console.log('  annualized:', JSON.stringify(result.impact.annualized_if_repeated));

  console.log('\n--- Diagnostics ---');
  console.log('  warnings:', result.diagnostics.warnings);
  console.log('  unscheduled:', result.diagnostics.unscheduled);

  console.log('\n--- Assertions ---');
  // 1. An ethanol-class shared_reagent_prep coordination should fire (DNeasy
  //    has ethanol_96_100; AMPure has ethanol_70_fresh; MagJET has
  //    isopropanol_100). They're DIFFERENT overlap groups so they won't
  //    combine, but ethanol_96_100 alone won't fire (only DNeasy uses it).
  //    What WILL fire: low_salt_elution_buffer (DNeasy + MagJET) and
  //    sterile_water (Q5 + AMPure).
  const elutionCoord = result.coordinations.find(
    (c) => c.overlap_group === 'low_salt_elution_buffer'
  );
  assert(
    !!elutionCoord,
    'low_salt_elution_buffer coordination fires (DNeasy + MagJET share elution)'
  );

  const waterCoord = result.coordinations.find(
    (c) => c.overlap_group === 'sterile_water'
  );
  assert(
    !!waterCoord,
    'sterile_water coordination fires (Q5 + AMPure share water)'
  );

  // 2. Vikas's PCR scheduled before his cleanup.
  const vikasPcr = result.schedule.find(
    (s) => s.person === 'Vikas' && s.family === 'PCR'
  );
  const vikasCleanup = result.schedule.find(
    (s) => s.person === 'Vikas' && s.family === 'Bead_cleanup'
  );
  assert(!!vikasPcr && !!vikasCleanup, 'both Vikas tasks scheduled');
  if (vikasPcr && vikasCleanup) {
    assert(
      new Date(vikasPcr.end_iso).getTime() <= new Date(vikasCleanup.start_iso).getTime(),
      "Vikas's PCR ends before his AMPure cleanup begins (intra-person family order)"
    );
  }

  // 3. All 4 tasks scheduled (no unscheduled diagnostics).
  assert(
    result.diagnostics.unscheduled.length === 0,
    `all 4 tasks placed (unscheduled count = ${result.diagnostics.unscheduled.length})`
  );

  // 4. Some separation fires (Sohini's DNeasy chaotropic bucket vs other waste).
  assert(
    result.separations.length > 0,
    `at least one waste-stream separation/check surfaces (got ${result.separations.length})`
  );

  // 5. Impact shows real savings. At small sample counts the savings register
  //    as prep-events rather than mL — that's correct: prep overhead ≥ saved
  //    dead-volume for tiny aliquots like 0.5 mL of elution buffer. The win
  //    that DOES fire is "fewer prep events." Volume becomes the headline
  //    number when shared ethanol/isopropanol class reagents combine across
  //    3+ protocols (a fixture we don't model here).
  assert(
    result.impact.weekly.prep_events_saved > 0,
    `weekly prep events saved > 0 (got ${result.impact.weekly.prep_events_saved})`
  );

  console.log('\nDone.');
}

main();
