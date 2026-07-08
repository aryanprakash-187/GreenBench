// POST /api/parse
//
// Universal protocol PDF extractor. The frontend uploads a PDF (or any
// text-ish file) and receives a DraftProtocol the user can review and
// confirm in the UI before it's resolved into an EnrichedProtocol and sent
// to /api/plan.
//
// Request shape (multipart/form-data only, since we accept binary PDFs):
//   - file:   the PDF (required)
//
// Response shape (200):
//   {
//     ok: true,
//     draft: DraftProtocol,
//     allowed_overlap_groups: string[],   // closed vocabulary the UI shows
//     model: string,                      // Gemini model id we used
//     elapsed_ms: number,
//   }
//
// Error responses use { ok: false, code, message } and an HTTP status that
// matches the error category.

import { NextRequest, NextResponse } from 'next/server';

import { extractPdfTextSample } from '@/lib/llm/pdfText';
import { parseProtocolFromPdf } from '@/lib/llm/parseProtocol';
import { allowedOverlapGroupValues } from '@/lib/llm/schemas';

export const runtime = 'nodejs';
// Gemini 2.5 Pro on a multi-page PDF can take 30s — bump the route's
// allowed duration well above Vercel's default 10s. The parser itself has
// a 45s internal timeout (see parseProtocol.ts).
export const maxDuration = 60;

const MAX_FILE_BYTES = 30 * 1024 * 1024;
const PDF_TEXT_FALLBACK_BUDGET = 60_000;

export async function POST(req: NextRequest) {
  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.includes('multipart/form-data')) {
    return NextResponse.json(
      {
        ok: false,
        code: 'BAD_INPUT',
        message:
          'Use multipart/form-data with a "file" field containing the PDF.',
      },
      { status: 415 }
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        code: 'BAD_INPUT',
        message: `Could not parse multipart form: ${(err as Error).message}`,
      },
      { status: 400 }
    );
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json(
      {
        ok: false,
        code: 'BAD_INPUT',
        message: 'multipart/form-data must include a "file" field.',
      },
      { status: 400 }
    );
  }
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json(
      {
        ok: false,
        code: 'INPUT_TOO_LARGE',
        message: `File exceeds ${(MAX_FILE_BYTES / 1024 / 1024).toFixed(0)} MB.`,
      },
      { status: 413 }
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const mimeType = file.type || guessMime(file.name);
  const filename = file.name || 'upload.pdf';

  // For PDFs we still try the cheap text extractor first. If it succeeds the
  // parser sends Claude the text excerpt (faster, cheaper). If it fails — or
  // the extractor throws on a malformed/encrypted PDF — we hand Claude the raw
  // bytes as a document block instead. The try/catch matters: an unguarded
  // throw here would crash the request and surface as a browser "Failed to
  // fetch" rather than a clean fallback.
  let textFallback: string | undefined;
  if (isPdfLike(mimeType, filename)) {
    try {
      const extracted = await extractPdfTextSample(bytes, PDF_TEXT_FALLBACK_BUDGET);
      console.log(`[parse] ${filename}: extracted ${extracted?.length ?? 'null'} chars`);
      if (extracted && extracted.length > 0) {
        textFallback = extracted;
      }
    } catch (err) {
      console.warn(
        `[parse] ${filename}: text extraction failed (${(err as Error).message}); sending PDF bytes to Claude.`
      );
    }
  } else if (
    mimeType?.startsWith('text/') ||
    /\.(txt|md|csv|tsv)$/i.test(filename)
  ) {
    // Text-ish file: skip the binary path entirely.
    textFallback = bytes.toString('utf8').slice(0, PDF_TEXT_FALLBACK_BUDGET);
  }

  // Decide whether to send bytes:
  //   - If we got a clean text fallback, send TEXT ONLY (no binary).
  //   - Otherwise, send the binary PDF and let Gemini OCR.
  // This mirrors /api/match's behavior and keeps tokens / latency down.
  const result = await parseProtocolFromPdf(
    textFallback
      ? {
          filename,
          // Parser requires a Buffer (even when unused); an empty one is
          // fine because the text_fallback branch never touches it.
          file_bytes: Buffer.alloc(0),
          mime_type: mimeType,
          text_fallback: textFallback,
        }
      : {
          filename,
          file_bytes: bytes,
          mime_type: mimeType,
        }
  );

  if (!result.ok) {
    const status = statusForCode(result.code);
    return NextResponse.json(
      {
        ok: false,
        code: result.code,
        message: result.message,
      },
      { status }
    );
  }

  return NextResponse.json(
    {
      ok: true,
      draft: result.draft,
      allowed_overlap_groups: allowedOverlapGroupValues(),
      model: result.model,
      elapsed_ms: result.elapsed_ms,
    },
    { status: 200 }
  );
}

function isPdfLike(mime: string | undefined, filename: string): boolean {
  return mime === 'application/pdf' || /\.pdf$/i.test(filename);
}

function guessMime(filename: string): string {
  if (/\.pdf$/i.test(filename)) return 'application/pdf';
  if (/\.(txt|md)$/i.test(filename)) return 'text/plain';
  if (/\.docx$/i.test(filename))
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  return 'application/octet-stream';
}

function statusForCode(code: string): number {
  switch (code) {
    case 'BAD_INPUT':
      return 400;
    case 'INPUT_TOO_LARGE':
      return 413;
    case 'NO_API_KEY':
      return 503;
    case 'TIMEOUT':
      return 504;
    case 'INVALID_JSON':
    case 'SCHEMA_MISMATCH':
    case 'EMPTY_RESPONSE':
      return 502;
    case 'RATE_LIMITED':
      return 429;
    case 'UPSTREAM_ERROR':
    default:
      return 502;
  }
}
