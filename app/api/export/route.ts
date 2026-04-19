// POST /api/export
//
// Server-side wrapper around lib/export/ics.ts. The UI builds .ics files
// client-side already (the lib is browser-safe), but this route exists so:
//   - curl users can pipe a NarratedWeekPlanResult into a .ics file
//   - the per-person calendar can be linked / shared via URL later
//   - a future stretch goal (signed shareable schedule URL) gets a stable
//     entry point now
//
// Body: application/json
//   {
//     person_name: string,                // must match a name in plan.schedule
//     plan: NarratedWeekPlanResult,       // typically piped from /api/plan?narrate=1
//     busy_ics_text?: string              // user's original .ics (passes through verbatim)
//   }
//
// Query:
//   ?download=1   set Content-Disposition so a browser hit triggers a save dialog
//
// Returns: text/calendar (ICS body)

import { NextRequest, NextResponse } from 'next/server';

import { buildPersonIcs, suggestIcsFilename } from '@/lib/export/ics';
import type { NarratedWeekPlanResult } from '@/lib/engine/types';

export const runtime = 'nodejs';

interface IncomingBody {
  person_name?: string;
  plan?: NarratedWeekPlanResult;
  busy_ics_text?: string;
}

export async function POST(req: NextRequest) {
  let body: IncomingBody;
  try {
    body = (await req.json()) as IncomingBody;
  } catch {
    return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 });
  }

  if (!body.person_name || typeof body.person_name !== 'string') {
    return NextResponse.json(
      { error: '"person_name" is required.' },
      { status: 400 }
    );
  }
  if (!body.plan || typeof body.plan !== 'object') {
    return NextResponse.json(
      { error: '"plan" (NarratedWeekPlanResult) is required.' },
      { status: 400 }
    );
  }
  if (!Array.isArray(body.plan.schedule)) {
    return NextResponse.json(
      { error: '"plan.schedule" must be an array.' },
      { status: 400 }
    );
  }

  // Soft validate: if no scheduled task or coordination references this
  // person, we still emit a calendar (the user's busy events will pass
  // through), but we surface a header so callers can detect it.
  const hasAnything =
    body.plan.schedule.some((s) => s.person === body.person_name) ||
    body.plan.coordinations.some((c) =>
      c.participants.some((p) => p.person === body.person_name)
    );

  let icsText: string;
  try {
    icsText = buildPersonIcs({
      personName: body.person_name,
      plan: body.plan,
      busyIcsText: body.busy_ics_text ?? '',
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message ?? 'Failed to build ICS' },
      { status: 500 }
    );
  }

  const url = new URL(req.url);
  const wantsDownload = url.searchParams.get('download') === '1';

  const headers: Record<string, string> = {
    'Content-Type': 'text/calendar; charset=utf-8',
    'X-Greenbench-Person': body.person_name,
    'X-Greenbench-Has-Plan-Items': hasAnything ? '1' : '0',
  };
  if (wantsDownload) {
    headers['Content-Disposition'] = `attachment; filename="${suggestIcsFilename(
      body.person_name
    )}"`;
  }

  return new NextResponse(icsText, { status: 200, headers });
}
