// Tiny wrapper around unpdf to pull a small text excerpt out of a PDF buffer.
//
// Used by /api/match so the deterministic keyword tier can run on PDFs and
// the LLM tier (when needed) only receives a few KB of plain text instead
// of a multi-MB base64-encoded PDF. unpdf is a pure-JS, serverless-friendly
// fork of Mozilla's pdf.js that doesn't require any native bindings — so it
// works in the Next.js Node runtime without extra build configuration.
//
// The function never throws on parse failures (encrypted PDFs, all-image
// scans, malformed files). It returns null and the caller falls back to
// passing raw bytes to Gemini, exactly as before this module existed.

// IMPORTANT: side-effect import must come before unpdf so the Promise.try
// polyfill is installed before pdf.js's worker callbacks ever fire.
import './promiseTryPolyfill';
import { extractText, getDocumentProxy } from 'unpdf';

/** Extract up to `maxChars` characters of text from a PDF buffer.
 *  Returns null on any failure (encrypted, image-only, malformed, etc.). */
export async function extractPdfTextSample(
  bytes: Buffer,
  maxChars: number
): Promise<string | null> {
  try {
    // unpdf wants a Uint8Array; Buffer IS one but TS can be picky if Buffer's
    // type lib doesn't widen, so coerce explicitly.
    const u8 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const doc = await getDocumentProxy(u8);
    // mergePages flattens to one string; we don't care about page boundaries
    // for keyword scanning, and concatenation is cheap.
    const { text } = await extractText(doc, { mergePages: true });
    const flat = (typeof text === 'string' ? text : (text as string[]).join('\n'))
      .replace(/\u0000/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .trim();
    if (flat.length === 0) return null;
    return flat.slice(0, maxChars);
  } catch {
    return null;
  }
}
