// Smoke test for the LLM narrator (Layer 4).
//
// What it covers:
//   1. Build a realistic WeekPlanResult from the seed data: hydrate the demo
//      pipeline (DNeasy + AMPure for one person, MagJET + Q5 for the other),
//      run the engine, get back coordinations / separations / impact.
//   2. Run narrateWeekPlan() in offline mode (deterministic templates).
//   3. Assert the output is the same shape as the input plus prose:
//        - byte-identical schedule, impact, diagnostics
//        - same number of coordinations, same ids, same savings numbers
//        - every coordination has prose.{headline, body, savings_phrase}
//        - savings_phrase contains at least one digit
//        - headline ≤ 90 chars, body ≤ 280 chars
//        - narration.generated === false (offline path)
//   4. Optionally re-run with --llm to exercise the Gemini path live; same
//      assertions plus narration.generated === true.
//
// Run:   npx tsx scripts/test-narrate.ts
// Live:  npx tsx scripts/test-narrate.ts --llm

// Load .env.local first so GEMINI_API_KEY is available when --llm is set.
// (Next.js loads it automatically in dev/prod; standalone tsx scripts don't.)
import { config as dotenvConfig } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
const envLocal = resolve(process.cwd(), '.env.local');
if (existsSync(envLocal)) dotenvConfig({ path: envLocal });
else dotenvConfig();

import { hydrateProtocol } from '../lib/engine/hydrate';
import { planWeek } from '../lib/engine';
import { nextMondayLocalIso } from '../lib/engine/ics';
import { narrateWeekPlan } from '../lib/llm/narrate';
import type {
  EnginePlanInput,
  HydratedTask,
  NarratedWeekPlanResult,
  WeekPlanResult,
} from '../lib/engine/types';

const HEADLINE_MAX = 90;
const BODY_MAX = 280;

interface Failure {
  name: string;
  reason: string;
}

function buildPlan(): EnginePlanInput {
  const sohiniDneasy = hydrateProtocol({
    protocol_name: 'DNeasy Blood & Tissue',
    sample_count: 8,
    matched_via: 'manual',
  });
  const sohiniMagjet = hydrateProtocol({
    protocol_name: 'MagJET Genomic DNA Kit',
    sample_count: 4,
    matched_via: 'manual',
  });
  const vikasQ5 = hydrateProtocol({
    protocol_name: 'Q5 Hot Start High-Fidelity 2X Master Mix',
    sample_count: 12,
    matched_via: 'manual',
  });
  const vikasAmpure = hydrateProtocol({
    protocol_name: 'Agencourt AMPure XP PCR Purification',
    sample_count: 12,
    matched_via: 'manual',
  });

  const task = (id: string, protocol: typeof sohiniDneasy): HydratedTask => ({
    task_id: id,
    protocol,
  });

  return {
    week_start_iso: nextMondayLocalIso(),
    people: [
      {
        name: 'Sohini',
        busy: [],
        tasks: [
          task('sohini__dneasy__1', sohiniDneasy),
          task('sohini__magjet__1', sohiniMagjet),
        ],
      },
      {
        name: 'Vikas',
        busy: [],
        tasks: [
          task('vikas__q5__1', vikasQ5),
          task('vikas__ampure__1', vikasAmpure),
        ],
      },
    ],
  };
}

function assertSameShape(
  before: WeekPlanResult,
  after: NarratedWeekPlanResult,
  failures: Failure[]
): void {
  if (before.coordinations.length !== after.coordinations.length) {
    failures.push({
      name: 'shape: coordinations length',
      reason: `expected ${before.coordinations.length}, got ${after.coordinations.length}`,
    });
  }
  if (before.separations.length !== after.separations.length) {
    failures.push({
      name: 'shape: separations length',
      reason: `expected ${before.separations.length}, got ${after.separations.length}`,
    });
  }
  if (before.schedule.length !== after.schedule.length) {
    failures.push({
      name: 'shape: schedule length',
      reason: `expected ${before.schedule.length}, got ${after.schedule.length}`,
    });
  }
  // Spot-check that engine fields pass through unchanged on each coord.
  for (let i = 0; i < before.coordinations.length; i++) {
    const a = before.coordinations[i];
    const b = after.coordinations[i];
    if (a.id !== b.id) {
      failures.push({
        name: `coord[${i}].id`,
        reason: `id changed: ${a.id} → ${b.id}`,
      });
    }
    if (JSON.stringify(a.savings) !== JSON.stringify(b.savings)) {
      failures.push({
        name: `coord[${i}].savings`,
        reason: 'savings struct changed; narrator must not touch numbers',
      });
    }
    if (JSON.stringify(a.citations) !== JSON.stringify(b.citations)) {
      failures.push({
        name: `coord[${i}].citations`,
        reason: 'citations changed; narrator must not touch citations',
      });
    }
  }
}

function assertProseQuality(
  after: NarratedWeekPlanResult,
  failures: Failure[]
): void {
  if (!after.headline_tagline || after.headline_tagline.trim().length === 0) {
    failures.push({
      name: 'headline_tagline',
      reason: 'empty',
    });
  }
  for (let i = 0; i < after.coordinations.length; i++) {
    const c = after.coordinations[i];
    if (!c.prose) {
      failures.push({ name: `coord[${i}].prose`, reason: 'missing' });
      continue;
    }
    if (!c.prose.headline || c.prose.headline.length === 0) {
      failures.push({ name: `coord[${i}].prose.headline`, reason: 'empty' });
    }
    if (c.prose.headline.length > HEADLINE_MAX) {
      failures.push({
        name: `coord[${i}].prose.headline`,
        reason: `length ${c.prose.headline.length} > ${HEADLINE_MAX}`,
      });
    }
    if (c.prose.body.length > BODY_MAX) {
      failures.push({
        name: `coord[${i}].prose.body`,
        reason: `length ${c.prose.body.length} > ${BODY_MAX}`,
      });
    }
    if (!/\d/.test(c.prose.savings_phrase)) {
      failures.push({
        name: `coord[${i}].prose.savings_phrase`,
        reason: `no digit in "${c.prose.savings_phrase}"`,
      });
    }
  }
  for (let i = 0; i < after.separations.length; i++) {
    const s = after.separations[i];
    if (!s.prose) {
      failures.push({ name: `sep[${i}].prose`, reason: 'missing' });
      continue;
    }
    if (s.prose.headline.length === 0 || s.prose.headline.length > HEADLINE_MAX) {
      failures.push({
        name: `sep[${i}].prose.headline`,
        reason: `length ${s.prose.headline.length}`,
      });
    }
    if (s.prose.body.length > BODY_MAX) {
      failures.push({
        name: `sep[${i}].prose.body`,
        reason: `length ${s.prose.body.length} > ${BODY_MAX}`,
      });
    }
  }
}

async function main() {
  const useLlm = process.argv.includes('--llm');
  const failures: Failure[] = [];

  console.log('Building synthetic WeekPlanResult from seed data...');
  const input = buildPlan();
  const plan = planWeek(input);
  console.log(
    `  engine produced ${plan.coordinations.length} coordinations, ${plan.separations.length} separations, ${plan.schedule.length} scheduled tasks.`
  );

  // Pass 1: deterministic fallback (no LLM).
  console.log('\nNarrating offline (deterministic fallback)...');
  const offline = await narrateWeekPlan(plan, { disable_llm: true });
  if (offline.narration.generated) {
    failures.push({
      name: 'offline narration.generated',
      reason: 'expected false when disable_llm=true',
    });
  }
  console.log(
    `  fallback_reason: ${offline.narration.fallback_reason || '(empty)'}`
  );
  console.log(`  headline_tagline: ${offline.headline_tagline}`);
  if (offline.coordinations[0]) {
    console.log(
      `  coord[0].prose.headline: ${offline.coordinations[0].prose.headline}`
    );
    console.log(
      `  coord[0].prose.savings_phrase: ${offline.coordinations[0].prose.savings_phrase}`
    );
  }
  assertSameShape(plan, offline, failures);
  assertProseQuality(offline, failures);

  // Pass 2 (optional): live LLM.
  if (useLlm) {
    console.log('\nNarrating with Gemini (live)...');
    const live = await narrateWeekPlan(plan);
    if (!live.narration.generated) {
      failures.push({
        name: 'live narration.generated',
        reason: `expected true; fallback_reason: ${live.narration.fallback_reason}`,
      });
    } else {
      console.log(`  model: ${live.narration.model}`);
      console.log(`  headline_tagline: ${live.headline_tagline}`);
      if (live.coordinations[0]) {
        console.log(
          `  coord[0].prose.headline: ${live.coordinations[0].prose.headline}`
        );
        console.log(
          `  coord[0].prose.body: ${live.coordinations[0].prose.body}`
        );
        console.log(
          `  coord[0].prose.savings_phrase: ${live.coordinations[0].prose.savings_phrase}`
        );
      }
    }
    assertSameShape(plan, live, failures);
    assertProseQuality(live, failures);
  }

  console.log('');
  if (failures.length === 0) {
    console.log(`PASS — all narrator checks green${useLlm ? ' (offline + live)' : ' (offline)'}`);
    return;
  }
  console.log(`FAIL — ${failures.length} failure(s):`);
  for (const f of failures) {
    console.log(`  - ${f.name}: ${f.reason}`);
  }
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
