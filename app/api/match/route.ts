// POST /api/match
//
// Resolves an uploaded protocol file to one of the 9 curated protocol_name values.
// Optionally hydrates the matched protocol into a fully enriched JSON in one round
// trip (when ?hydrate=1&samples=N is passed in the form, or as JSON body).
//
// Accepts either:
//   - multipart/form-data with field "file" (and optional "samples", "hydrate")
//   - application/json with { filename, text_sample?, samples?, hydrate? }
//
// Returns:
//   {
//     match: ProtocolMatchResult,
//     enriched: EnrichedProtocol | null   // null when hydrate=false or match failed
//   }

import { NextRequest, NextResponse } from 'next/server';

import { hydrateProtocol, HydrateError } from '@/lib/engine/hydrate';
import { extractPdfTextSample } from '@/lib/llm/pdfText';
import { matchProtocol } from '@/lib/llm/matchProtocol';

// We use unpdf (a serverless-friendly Mozilla pdf.js wrapper) to pull a small
// text excerpt out of PDFs server-side. That has two big payoffs:
//   1. The deterministic keyword tier (Tier 2 of the matcher) now runs on
//      PDFs — for ~80% of vendor uploads that means we never touch Gemini.
//   2. When we DO need Gemini, we send a few KB of text instead of a
//      multi-MB base64 PDF, cutting tier-3 latency by an order of magnitude.
export const runtime = 'nodejs';

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB cap so a malicious upload can't OOM the route
const PDF_TEXT_CHAR_BUDGET = 8_000;

interface JsonBody {
  filename?: string;
  text_sample?: string;
  samples?: number | string;
  hydrate?: boolean;
}

export async function POST(req: NextRequest) {
  const contentType = req.headers.get('content-type') ?? '';

  let filename = '';
  let textSample: string | undefined;
  let fileBytes: Buffer | undefined;
  let mimeType: string | undefined;
  let samples: number | undefined;
  let hydrate = false;

  try {
    if (contentType.includes('multipart/form-data')) {
      const form = await req.formData();
      const file = form.get('file');
      if (!(file instanceof File)) {
        return NextResponse.json(
          { error: 'multipart/form-data must include a "file" field.' },
          { status: 400 }
        );
      }
      if (file.size > MAX_FILE_BYTES) {
        return NextResponse.json(
          { error: `File exceeds ${MAX_FILE_BYTES} bytes.` },
          { status: 413 }
        );
      }
      filename = file.name;
      mimeType = file.type || undefined;

      const bytes = Buffer.from(await file.arrayBuffer());
      fileBytes = bytes;
      // For text-ish files, also extract a text_sample so the deterministic tier
      // can do keyword scanning without needing the LLM.
      if (
        mimeType?.startsWith('text/') ||
        /\.(txt|md|csv|tsv)$/i.test(filename)
      ) {
        textSample = bytes.toString('utf8');
      } else if (
        mimeType === 'application/pdf' ||
        /\.pdf$/i.test(filename)
      ) {
        // Best-effort PDF text extraction. Failures (encrypted PDFs, all-image
        // scans, malformed files) are non-fatal — we just fall through to the
        // LLM tier with the raw bytes, same as before.
        const extracted = await extractPdfTextSample(bytes, PDF_TEXT_CHAR_BUDGET);
        if (extracted && extracted.trim().length > 0) {
          textSample = extracted;
          // Once we have text, drop the raw bytes — sending both is wasteful
          // and the LLM tier's userBlock prefers text_sample anyway.
          fileBytes = undefined;
        }
      }

      const samplesRaw = form.get('samples');
      if (typeof samplesRaw === 'string') {
        // Round to integer so the match endpoint and the plan endpoint can't
        // disagree about how many samples the lab is processing — the
        // frontend's parsePositiveInt truncates "8.7" to 8, so we mirror it
        // (Math.round is forgiving for honest decimals like 8.5 → 9 / 9 → 9).
        const parsed = Number(samplesRaw);
        samples = Number.isFinite(parsed) ? Math.round(parsed) : undefined;
      }

      const hydrateRaw = form.get('hydrate');
      hydrate = hydrateRaw === '1' || hydrateRaw === 'true';
    } else if (contentType.includes('application/json')) {
      const body = (await req.json()) as JsonBody;
      filename = body.filename ?? '';
      textSample = body.text_sample;
      {
        const raw =
          typeof body.samples === 'string' ? Number(body.samples) : body.samples;
        // Same Math.round consistency so the JSON path matches the form path
        // (both, in turn, match the frontend's parseInt-based parsePositiveInt).
        samples =
          typeof raw === 'number' && Number.isFinite(raw)
            ? Math.round(raw)
            : undefined;
      }
      hydrate = !!body.hydrate;
    } else {
      return NextResponse.json(
        {
          error:
            'Unsupported content-type. Use multipart/form-data with a "file" field or application/json.',
        },
        { status: 415 }
      );
    }

    if (!filename) {
      return NextResponse.json(
        { error: 'A filename is required (either via the uploaded file or the JSON body).' },
        { status: 400 }
      );
    }

    const match = await matchProtocol({
      filename,
      mime_type: mimeType,
      text_sample: textSample,
      file_bytes: fileBytes,
    });

    let enriched = null;
    if (hydrate && match.protocol_name) {
      const sampleCount = samples && Number.isFinite(samples) && samples > 0 ? samples : 8;
      try {
        enriched = hydrateProtocol({
          protocol_name: match.protocol_name,
          sample_count: sampleCount,
          matched_via: match.matched_via === 'none' ? 'manual' : match.matched_via,
        });
      } catch (err) {
        if (err instanceof HydrateError) {
          return NextResponse.json(
            {
              match,
              enriched: null,
              hydrate_error: { code: err.code, message: err.message },
            },
            { status: 200 }
          );
        }
        throw err;
      }
    }

    return NextResponse.json({ match, enriched }, { status: 200 });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message ?? 'Unknown error' },
      { status: 500 }
    );
  }
}
