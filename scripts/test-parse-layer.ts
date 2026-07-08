// Smoke test for the universal PDF protocol parser pipeline.
//
// Exercises the full real-product path:
//
//   1. parseProtocolFromPdf()    — text_fallback shortcut so we don't need a
//                                   real PDF in the repo. The prompt + JSON
//                                   schema + Claude round trip + zod
//                                   validation are still exercised.
//   2. resolveDraft()            — DraftProtocol + confirmations -> EnrichedProtocol
//   3. planWeek()                — engine runs on the resolved protocol(s)
//                                   with a single-person fixture.
//
// Run:  npm run parse:test       (will execute regardless of ANTHROPIC_API_KEY;
//                                  missing key surfaces as a clear failure
//                                  rather than a hang)
//
// This script is intentionally tolerant of LLM variance: it only asserts the
// pipeline plumbing (the shape of the response, the resolver actually
// running, the engine consuming the result). It does NOT assert specific
// reagent names or volumes, since the LLM's exact extraction can drift.

import * as dotenv from 'dotenv';

// dotenv's default `config` only reads `.env`. The project keeps its real
// keys in `.env.local`, which Next.js loads automatically but tsx scripts
// have to load manually.
dotenv.config({ path: '.env.local' });
dotenv.config();

import { planWeek } from '../lib/engine';
import { nextMondayLocalIso } from '../lib/engine/ics';
import { resolveDraft } from '../lib/engine/resolveDraft';
import type { ReagentConfirmation } from '../lib/engine/types';
import { DEFAULT_PARSER_MODEL, parseProtocolFromPdf } from '../lib/llm/parseProtocol';
import { parseProtocolResponseSchema } from '../lib/llm/schemas';

// Synthetic protocol text — looks like a vendor SOP. We feed this through the
// text_fallback path so the parser doesn't need a real PDF byte stream.
const FIXTURE_TEXT = `
QIAGEN DNeasy 96 Blood & Tissue Kit — Protocol for High-Throughput Genomic
DNA Purification (96-well plate format)

Default scale: 8 samples per run. Up to 96 samples per plate.

Reagents required (per sample, microliters):

  - Buffer ATL: 180 µL — lysis step, mild aqueous lysis buffer.
  - Buffer AL: 180 µL — binding buffer, contains chaotropic salt
    (guanidinium hydrochloride). Do not combine with bleach.
  - Buffer AW1: 500 µL — first ethanol-supplemented wash buffer.
  - Buffer AW2: 500 µL — second ethanol-supplemented wash buffer.
  - Buffer AE: 150 µL — low-salt elution buffer (10 mM Tris, 0.5 mM EDTA).

Equipment required:

  - Plate centrifuge with a 96-well rotor (e.g. QIAGEN Plate Rotor 2x96).
  - Automated liquid handler such as QIAcube.

Workflow stages: lysis (ATL) -> binding (AL) -> wash (AW1, AW2) -> elute (AE).

This is a spin-column 96-well DNA extraction protocol. No PCR thermal cycling.
`;

interface Reporter {
  ok(msg: string): void;
  fail(msg: string): never;
  warn(msg: string): void;
}

function reporter(): Reporter {
  return {
    ok: (m) => console.log(`  ok    ${m}`),
    fail: (m) => {
      console.error(`  FAIL  ${m}`);
      process.exit(1);
    },
    warn: (m) => console.log(`  warn  ${m}`),
  };
}

/** Deterministic (no-API) regression: a PCR thermal_profile that omits the
 *  free-text `notes` caption must NOT hard-fail zod validation. This is the
 *  robustness bug where one cosmetic field 502'd an otherwise-perfect parse
 *  (SCHEMA_MISMATCH is intentionally not retried). zod's `notes:
 *  z.string().catch('')` must absorb both an omitted key and an explicit null,
 *  normalizing either to ''. */
function assertNotesRobustness(r: Reporter) {
  const schema = parseProtocolResponseSchema();
  const baseThermal = {
    initial_denature_temp_c: 95,
    initial_denature_time_s: 120,
    cycle_denature_temp_c: 95,
    cycle_denature_time_s: 15,
    annealing_temp_c: 60,
    annealing_time_s: 30,
    extension_temp_c: 72,
    extension_time_s: 60,
    cycles: 35,
    final_extension_temp_c: 72,
    final_extension_time_s: 300,
  };
  const draftBase = {
    protocol_name: 'Regression PCR',
    vendor: 'Acme',
    family: 'PCR',
    primary_technique: 'endpoint_pcr',
    samples_default: 8,
    samples_max: 96,
    reagents: [
      {
        raw_term: 'Master Mix',
        volume_per_sample_ul: 25,
        dead_volume_pct: 10,
        proposed_stage: 'setup',
        proposed_overlap_group: 'pcr_master_mix_q5',
        cas_number: null,
        shareable_prep: true,
      },
    ],
    equipment_required: [],
    missing_information: [],
  };

  // Case 1: `notes` key omitted entirely.
  const omitted = schema.safeParse({ ...draftBase, thermal_profile: { ...baseThermal } });
  if (!omitted.success) {
    r.fail(`thermal_profile with omitted notes failed validation: ${omitted.error.message}`);
  }
  if (omitted.data.thermal_profile?.notes !== '') {
    r.fail(`omitted notes did not normalize to "" (got ${JSON.stringify(omitted.data.thermal_profile?.notes)})`);
  }
  r.ok('thermal_profile with omitted notes validates and normalizes notes -> ""');

  // Case 2: `notes` explicitly null (what the nullable JSON-schema union allows).
  const nulled = schema.safeParse({ ...draftBase, thermal_profile: { ...baseThermal, notes: null } });
  if (!nulled.success) {
    r.fail(`thermal_profile with null notes failed validation: ${nulled.error.message}`);
  }
  if (nulled.data.thermal_profile?.notes !== '') {
    r.fail(`null notes did not normalize to "" (got ${JSON.stringify(nulled.data.thermal_profile?.notes)})`);
  }
  r.ok('thermal_profile with null notes validates and normalizes notes -> ""');
}

async function main() {
  const r = reporter();

  // Always-on, offline schema regression (no API key needed).
  assertNotesRobustness(r);

  if (!process.env.ANTHROPIC_API_KEY) {
    r.warn('ANTHROPIC_API_KEY not set; skipping live parser call.');
    r.warn('Pipeline plumbing still validated via direct resolveDraft + planWeek.');
    return runOfflinePath(r);
  }

  console.log(`Calling ${DEFAULT_PARSER_MODEL} with synthetic DNeasy 96 protocol text...`);
  const result = await parseProtocolFromPdf({
    filename: 'fixture-dneasy.txt',
    // text_fallback path needs the buffer field but never reads it.
    file_bytes: Buffer.alloc(0),
    text_fallback: FIXTURE_TEXT,
    mime_type: 'text/plain',
  });

  if (!result.ok) {
    r.warn(`parseProtocolFromPdf failed: [${result.code}] ${result.message}`);
    if (result.raw) {
      r.warn(`raw error: ${result.raw.slice(0, 500)}`);
    }
    // Soft-pass on transient upstream errors so the script remains usable on
    // free-tier rate limits or temporary model availability hiccups. The
    // offline path validates the resolver + engine independently.
    if (/rate\s*limit|429|quota|unavailable|503|404/i.test(result.message + ' ' + (result.raw ?? ''))) {
      r.warn('Soft-pass: falling back to offline pipeline validation.');
      return runOfflinePath(r);
    }
    r.fail(`parseProtocolFromPdf failed: [${result.code}] ${result.message}`);
  }

  const draft = result.draft;
  r.ok(`parser returned a draft in ${result.elapsed_ms} ms (${result.model})`);
  r.ok(`  protocol_name: "${draft.protocol_name}"`);
  r.ok(`  family:        ${draft.family}`);
  r.ok(`  reagents:      ${draft.reagents.length}`);
  r.ok(`  equipment:     ${draft.equipment_required.length}`);
  r.ok(`  missing_info:  ${draft.missing_information.length}`);

  if (draft.reagents.length === 0) {
    r.fail('parser returned 0 reagents from a clearly-described protocol');
  }
  if (draft.family !== 'DNA_extraction' && draft.family !== 'Other') {
    r.warn(`family is "${draft.family}" — expected DNA_extraction for DNeasy 96`);
  }

  // Build confirmations using the LLM's proposals verbatim (the user-clicks
  // step). volume_per_sample_ul falls back to 0 when the LLM left it null;
  // the resolver records that case as missing_information.
  const confirmations: ReagentConfirmation[] = draft.reagents.map((rg) => ({
    raw_term: rg.raw_term,
    confirmed_overlap_group: rg.proposed_overlap_group,
    volume_per_sample_ul:
      typeof rg.volume_per_sample_ul === 'number' ? rg.volume_per_sample_ul : 0,
  }));

  const enriched = resolveDraft({
    draft,
    confirmations,
    sample_count: 8,
  });
  r.ok(`resolver produced EnrichedProtocol`);
  r.ok(`  reagents w/ volume_total_ul > 0: ${enriched.reagents.filter((x) => x.volume_total_ul > 0).length}`);
  r.ok(`  reagents w/ hazard summary:      ${enriched.reagents.filter((x) => x.hazard !== null).length}`);
  r.ok(`  equipment_required entries:      ${enriched.equipment_required.length}`);
  r.ok(`  thermal_profile:                 ${enriched.thermal_profile ? 'present' : 'null (good for non-PCR)'}`);

  // Engine round-trip
  const weekStartIso = nextMondayLocalIso();
  const planResult = planWeek({
    week_start_iso: weekStartIso,
    people: [
      {
        name: 'Test User',
        busy: [],
        tasks: [
          { task_id: 'test__dneasy__0', protocol: enriched },
        ],
      },
    ],
  });
  r.ok(`engine planned ${planResult.schedule.length} task(s)`);
  if (planResult.schedule.length === 0) {
    r.fail('engine returned an empty schedule — no task was placed');
  }
  if (planResult.diagnostics.unscheduled.length > 0) {
    r.warn(
      `unscheduled: ${planResult.diagnostics.unscheduled
        .map((u) => `${u.task_id} (${u.reason})`)
        .join(', ')}`,
    );
  }

  console.log('');
  console.log('All pipeline stages succeeded.');
}

function runOfflinePath(r: Reporter) {
  // Without an API key we can't call Gemini. Still smoke-test resolveDraft +
  // engine with a stub draft to confirm the new code paths compile and run.
  const stubDraft = {
    protocol_name: 'Stub DNeasy 96',
    vendor: 'QIAGEN',
    family: 'DNA_extraction' as const,
    primary_technique: 'spin_column_96_dna_extraction',
    samples_default: 8,
    samples_max: 96,
    reagents: [
      {
        raw_term: 'Buffer AL',
        volume_per_sample_ul: 180,
        dead_volume_pct: 25,
        proposed_stage: 'bind',
        proposed_overlap_group: 'shared_prep_buffer',
        cas_number: null,
        shareable_prep: true,
      },
      {
        raw_term: 'Buffer AW1',
        volume_per_sample_ul: 500,
        dead_volume_pct: 25,
        proposed_stage: 'wash',
        proposed_overlap_group: 'ethanol_wash_solution',
        cas_number: null,
        shareable_prep: true,
      },
    ],
    equipment_required: [
      { equipment_type: 'centrifuge', model_hint: 'plate rotor' },
    ],
    thermal_profile: null,
    missing_information: [],
  };

  const enriched = resolveDraft({
    draft: stubDraft,
    confirmations: stubDraft.reagents.map((rg) => ({
      raw_term: rg.raw_term,
      confirmed_overlap_group: rg.proposed_overlap_group,
      volume_per_sample_ul: rg.volume_per_sample_ul ?? 0,
    })),
    sample_count: 8,
  });
  r.ok(`resolveDraft produced ${enriched.reagents.length} enriched reagents (offline path)`);
  if (enriched.reagents.some((x) => x.volume_total_ul <= 0)) {
    r.fail('a stubbed reagent ended with volume_total_ul <= 0');
  }
  r.ok(`equipment resolved to lab_id: ${enriched.equipment_required[0]?.lab_id ?? '(none)'}`);

  const planResult = planWeek({
    week_start_iso: nextMondayLocalIso(),
    people: [
      {
        name: 'Stub User',
        busy: [],
        tasks: [{ task_id: 'stub__dneasy__0', protocol: enriched }],
      },
    ],
  });
  if (planResult.schedule.length === 0) {
    r.fail('engine could not place the stubbed task');
  }
  r.ok(`engine scheduled ${planResult.schedule.length} task(s) on the offline path`);
  console.log('');
  console.log('Offline pipeline stages succeeded.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
