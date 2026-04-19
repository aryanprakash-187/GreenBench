// POST /api/narrate
//
// Layer 4 of the BenchGreen pipeline: take a deterministic WeekPlanResult
// (typically from /api/plan) and return a NarratedWeekPlanResult with prose
// fields attached to each coordination, separation, and the impact card.
//
// The narrator never throws on LLM failure — if Gemini is down, the response
// is still well-formed but `narration.generated === false` and prose comes
// from deterministic templates. The UI should always be able to render.
//
// Body: application/json — a WeekPlanResult, optionally wrapped:
//   { plan: WeekPlanResult, disable_llm?: boolean }
//   or
//   <WeekPlanResult itself>
//
// Returns: NarratedWeekPlanResult JSON.

import { NextRequest, NextResponse } from 'next/server';

import { narrateWeekPlan } from '@/lib/llm/narrate';
import type { WeekPlanResult } from '@/lib/engine/types';

export const runtime = 'nodejs';

interface IncomingBody {
  plan?: WeekPlanResult;
  disable_llm?: boolean;
  // Or a bare WeekPlanResult:
  week_start_iso?: string;
  schedule?: WeekPlanResult['schedule'];
  coordinations?: WeekPlanResult['coordinations'];
  separations?: WeekPlanResult['separations'];
  impact?: WeekPlanResult['impact'];
  diagnostics?: WeekPlanResult['diagnostics'];
}

export async function POST(req: NextRequest) {
  let body: IncomingBody;
  try {
    body = (await req.json()) as IncomingBody;
  } catch {
    return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 });
  }

  // Accept either { plan: ... } or a bare WeekPlanResult.
  const plan: WeekPlanResult | undefined =
    body.plan ??
    (body.week_start_iso && body.schedule && body.coordinations
      ? {
          week_start_iso: body.week_start_iso,
          schedule: body.schedule,
          coordinations: body.coordinations,
          separations: body.separations ?? [],
          impact: body.impact!,
          diagnostics: body.diagnostics ?? { warnings: [], unscheduled: [] },
        }
      : undefined);

  if (!plan) {
    return NextResponse.json(
      {
        error:
          'Body must be a WeekPlanResult, or { plan: WeekPlanResult, disable_llm? }.',
      },
      { status: 400 }
    );
  }

  // Allow the URL to also flip disable_llm for cheap manual testing
  // (curl ".../api/narrate?disable_llm=1" with a bare plan).
  const url = new URL(req.url);
  const disableLlm =
    body.disable_llm === true ||
    url.searchParams.get('disable_llm') === '1';

  const narrated = await narrateWeekPlan(plan, { disable_llm: disableLlm });
  return NextResponse.json(narrated, { status: 200 });
}
