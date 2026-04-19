// POST /api/hydrate
//
// Direct hydration entry point — used by the UI when the user has already picked
// a protocol from the seeded dropdown (no upload, no matching needed).
//
// Body: application/json
//   { protocol_name: string, sample_count: number }
// Returns:
//   { enriched: EnrichedProtocol }

import { NextRequest, NextResponse } from 'next/server';

import { hydrateProtocol, HydrateError } from '@/lib/engine/hydrate';

export const runtime = 'nodejs';

interface Body {
  protocol_name?: string;
  sample_count?: number | string;
}

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 });
  }

  if (!body.protocol_name || typeof body.protocol_name !== 'string') {
    return NextResponse.json(
      { error: '"protocol_name" is required.' },
      { status: 400 }
    );
  }
  const sampleCount = Number(body.sample_count ?? 0);
  if (!Number.isFinite(sampleCount) || sampleCount <= 0) {
    return NextResponse.json(
      { error: '"sample_count" must be a positive number.' },
      { status: 400 }
    );
  }

  try {
    const enriched = hydrateProtocol({
      protocol_name: body.protocol_name,
      sample_count: sampleCount,
      matched_via: 'manual',
    });
    return NextResponse.json({ enriched }, { status: 200 });
  } catch (err) {
    if (err instanceof HydrateError) {
      const status =
        err.code === 'UNKNOWN_PROTOCOL' || err.code === 'NO_REAGENTS' ? 404 : 422;
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status }
      );
    }
    return NextResponse.json(
      { error: (err as Error).message ?? 'Unknown error' },
      { status: 500 }
    );
  }
}
