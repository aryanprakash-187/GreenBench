// Three-tier protocol matcher.
//
// Tier 1: filename normalization      (no LLM, no I/O, ~80% of demo uploads)
// Tier 2: keyword scan over the file  (no LLM, scans up to a few KB of text)
// Tier 3: Gemini tiebreaker           (only when 1 and 2 are inconclusive)
//
// "Inconclusive" means: top score < CONFIDENCE_FLOOR, OR top two scores are within
// AMBIGUITY_DELTA of each other. Either way, we have to break the tie somehow.
//
// The matcher always returns a ProtocolMatchResult. When tier 3 is unavailable
// (no GEMINI_API_KEY) and tiers 1+2 are inconclusive, we return the deterministic
// best guess with `matched_via: 'keyword'` and a low confidence — the UI is then
// expected to show a disambiguation dropdown rather than silently proceeding.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadProtocols } from '../engine/data';
import type {
  ProtocolMatchCandidate,
  ProtocolMatchResult,
  ProtocolSelectedRow,
} from '../engine/types';
import {
  generateJson,
  llmAvailability,
  LlmClientError,
} from './client';
import {
  geminiResponseSchemaForMatch,
  protocolMatchSchema,
} from './schemas';

const CONFIDENCE_FLOOR = 0.55; // below this we don't trust the match
const AMBIGUITY_DELTA = 0.1;   // top two scores within this band -> ambiguous
const MAX_TEXT_FOR_KEYWORDS = 8_000;
const MAX_TEXT_FOR_LLM = 4_000;

export interface MatchInput {
  /** Original uploaded filename, e.g. "DNeasy_Blood_and_Tissue_Handbook.pdf". */
  filename: string;
  /** MIME type if known. Used to decide whether to send raw bytes to Gemini. */
  mime_type?: string;
  /** Plain-text excerpt extracted from the file. Optional — if absent and we need
   *  the LLM tier, we'll send the raw file via `file_bytes` instead. */
  text_sample?: string;
  /** Raw bytes of the file. Optional. Only used by the LLM tier as a last resort. */
  file_bytes?: Buffer;
  /** If true, never call the LLM (useful for tests and offline demo runs). */
  disable_llm?: boolean;
}

/** Run the three-tier match. Always resolves; never throws. */
export async function matchProtocol(input: MatchInput): Promise<ProtocolMatchResult> {
  const protocols = loadProtocols();

  // Tier 1: filename
  const filenameScores = scoreByFilename(input.filename, protocols);
  let best = pickBest(filenameScores);

  if (best.protocol_name && isConfident(filenameScores)) {
    return finalize(best, 'filename', filenameScores, 'Filename matched a protocol alias.');
  }

  // Tier 2: keyword scan over text
  const text = (input.text_sample ?? '').slice(0, MAX_TEXT_FOR_KEYWORDS);
  if (text.length > 0) {
    const keywordScores = scoreByKeywords(text, protocols);
    const merged = mergeScores(filenameScores, keywordScores);
    const mergedBest = pickBest(merged);
    if (mergedBest.protocol_name && isConfident(merged)) {
      return finalize(
        mergedBest,
        'keyword',
        merged,
        'Filename + in-document keyword scan converged on a single protocol.'
      );
    }
    // Fall through to LLM with the merged scores as the deterministic baseline.
    best = mergedBest;
    filenameScores.length = 0;
    filenameScores.push(...merged);
  }

  // Tier 3: Gemini tiebreaker
  if (!input.disable_llm && llmAvailability().available && (text.length > 0 || input.file_bytes)) {
    try {
      const llm = await runLlmTier(input);
      const candidates = upsertScore(filenameScores, llm.protocol_name, llm.confidence, [
        ...llm.reasons,
      ]);
      const llmBest: ProtocolMatchCandidate = {
        protocol_name: llm.protocol_name,
        score: llm.confidence,
        reasons: llm.reasons,
      };
      return finalize(
        llmBest,
        'llm',
        candidates,
        'Deterministic tiers were ambiguous; Gemini broke the tie.'
      );
    } catch (err) {
      // LLM failed — fall through to the deterministic best guess. Never crash.
      const note = err instanceof LlmClientError
        ? `LLM tiebreaker failed (${err.code}): ${err.message}`
        : `LLM tiebreaker threw: ${(err as Error).message}`;
      return finalize(best, 'keyword', filenameScores, note);
    }
  }

  // Best deterministic guess, possibly null.
  return finalize(
    best,
    best.protocol_name ? 'keyword' : 'none',
    filenameScores,
    text.length > 0
      ? 'Deterministic tiers ran but no candidate cleared the confidence floor; LLM tier unavailable.'
      : 'Filename match was inconclusive and no text sample was provided.'
  );
}

// ----- Tier 1: filename normalization -----

/** Tokens that often surround real protocol names in vendor PDFs but aren't
 *  themselves identifying. We strip them before fuzzy matching. */
const FILENAME_NOISE = [
  'handbook',
  'manual',
  'protocol',
  'kit',
  'quickstart',
  'quick-start',
  'product',
  'sheet',
  'instructions',
  'usermanual',
  'user',
  'guide',
  'rev',
  'revision',
  'datasheet',
  'doc',
  'document',
  'ifu',
  'sds',
];

/** Per-protocol aliases. The key is the canonical protocol_name; the values are
 *  alternate strings (vendor codenames, common abbreviations, family handles)
 *  the user might have in their filename. Strings are case-insensitive. */
const PROTOCOL_ALIASES: Record<string, string[]> = {
  'DNeasy Blood & Tissue': ['dneasy', 'dneasy blood', 'dneasy tissue', 'qiagen dneasy'],
  'GeneJET Genomic DNA Purification Kit': [
    'genejet',
    'genejet genomic',
    'thermo genejet',
    'genejet purification',
    'k0721', 'k0722',
  ],
  'MagJET Genomic DNA Kit': [
    'magjet genomic',
    'magjet gdna',
    'magjet dna',
    'thermo magjet genomic',
  ],
  'Q5 Hot Start High-Fidelity 2X Master Mix': [
    'q5',
    'q5 hot start',
    'q5 master mix',
    'q5 high fidelity',
    'neb q5',
    'm0494',
  ],
  'Platinum II Hot-Start PCR Master Mix (2X)': [
    'platinum ii',
    'platinum 2',
    'invitrogen platinum',
    'platinum hot-start',
    'platinum hot start',
  ],
  'JumpStart REDTaq ReadyMix Reaction Mix': [
    'jumpstart',
    'redtaq',
    'jumpstart redtaq',
    'sigma jumpstart',
    'p0982',
  ],
  'Agencourt AMPure XP PCR Purification': [
    'ampure',
    'ampure xp',
    'agencourt',
    'beckman ampure',
    'a63881', 'a63880',
  ],
  'MagJET NGS Cleanup and Size Selection Kit': [
    'magjet ngs',
    'magjet cleanup',
    'thermo magjet ngs',
    'k2821',
  ],
  'AxyPrep Mag PCR Clean-up': [
    'axyprep',
    'axyprep mag',
    'axygen',
    'axyprep cleanup',
    'mag-pcr-cl',
  ],
};

/** Returns TWO normalized forms of the filename:
 *    - `split`:   CamelCase boundaries broken apart ("PlatinumII" -> "platinum ii")
 *    - `compact`: separators flattened but tokens left intact ("DNeasy" stays "dneasy")
 *  Aliases get matched against both, since some brand names ARE camelcase ("DNeasy",
 *  "GeneJET", "MagJET", "JumpStart") and some product IDs aren't ("PlatinumII"). */
function normalizeFilename(filename: string): { split: string; compact: string } {
  const noExt = filename.replace(/\.[^./\\]+$/, '');

  const compactSpaced = noExt.replace(/[_\-./\\]+/g, ' ').toLowerCase();
  const compact = compactSpaced
    .split(/\s+/)
    .filter((t) => t.length > 0 && !FILENAME_NOISE.includes(t))
    .join(' ');

  const camelSplit = noExt
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-zA-Z])/g, '$1 $2');
  const splitSpaced = camelSplit.replace(/[_\-./\\]+/g, ' ').toLowerCase();
  const split = splitSpaced
    .split(/\s+/)
    .filter((t) => t.length > 0 && !FILENAME_NOISE.includes(t))
    .join(' ');

  return { split, compact };
}

function scoreByFilename(
  filename: string,
  protocols: ProtocolSelectedRow[]
): ProtocolMatchCandidate[] {
  const { split, compact } = normalizeFilename(filename);
  return protocols.map<ProtocolMatchCandidate>((p) => {
    const aliases = PROTOCOL_ALIASES[p.protocol_name] ?? [];
    const candidates = [p.protocol_name.toLowerCase(), ...aliases.map((a) => a.toLowerCase())];

    let bestScore = 0;
    const reasons: string[] = [];
    for (const c of candidates) {
      const matchedIn =
        split.includes(c) ? split : compact.includes(c) ? compact : null;
      if (matchedIn) {
        // Score by length of matched alias relative to the form it matched in.
        const score = Math.min(1, c.length / Math.max(8, matchedIn.length / 1.5));
        if (score > bestScore) {
          bestScore = score;
          reasons.length = 0;
          reasons.push(`Filename contains "${c}".`);
        }
      }
    }
    return { protocol_name: p.protocol_name, score: bestScore, reasons };
  });
}

// ----- Tier 2: keyword scan -----

/** Per-protocol weighted keywords for in-document scanning. We bias toward
 *  vendor + product cues (high weight) and back off to technique tokens
 *  (low weight). Keep this aligned with reagent_term_map.csv. */
const PROTOCOL_KEYWORDS: Record<string, Array<{ pattern: RegExp; weight: number; label: string }>> = {
  'DNeasy Blood & Tissue': [
    { pattern: /\bdneasy\b/i, weight: 0.7, label: 'DNeasy product name' },
    { pattern: /buffer\s*atl\b/i, weight: 0.4, label: 'Buffer ATL reagent' },
    { pattern: /buffer\s*aw1\b/i, weight: 0.4, label: 'Buffer AW1 reagent' },
    { pattern: /buffer\s*ae\b/i, weight: 0.3, label: 'Buffer AE reagent' },
    { pattern: /qiagen/i, weight: 0.3, label: 'QIAGEN vendor' },
  ],
  'GeneJET Genomic DNA Purification Kit': [
    { pattern: /genejet/i, weight: 0.7, label: 'GeneJET product name' },
    { pattern: /wash\s*buffer\s*ii\b/i, weight: 0.4, label: 'Wash Buffer II' },
    { pattern: /wash\s*buffer\s*i\b/i, weight: 0.4, label: 'Wash Buffer I' },
    { pattern: /thermo/i, weight: 0.2, label: 'Thermo Scientific vendor' },
    { pattern: /50\s*%\s*ethanol/i, weight: 0.2, label: '50% ethanol step' },
  ],
  'MagJET Genomic DNA Kit': [
    { pattern: /magjet/i, weight: 0.5, label: 'MagJET product family' },
    { pattern: /digestion\s*solution/i, weight: 0.4, label: 'Digestion Solution reagent' },
    { pattern: /0\.15\s*M\s*NaCl/i, weight: 0.4, label: '0.15 M NaCl resuspension step' },
    { pattern: /isopropanol/i, weight: 0.2, label: 'isopropanol bind step' },
  ],
  'Q5 Hot Start High-Fidelity 2X Master Mix': [
    { pattern: /\bq5\b/i, weight: 0.7, label: 'Q5 brand' },
    { pattern: /hot\s*start.*high.fidelity/i, weight: 0.4, label: 'Hot Start High-Fidelity phrase' },
    { pattern: /\bneb\b/i, weight: 0.3, label: 'NEB vendor' },
    { pattern: /98\s*°?\s*C/i, weight: 0.2, label: '98°C denaturation' },
  ],
  'Platinum II Hot-Start PCR Master Mix (2X)': [
    { pattern: /platinum\s*II\b/i, weight: 0.7, label: 'Platinum II brand' },
    { pattern: /platinum\s*GC\s*enhancer/i, weight: 0.4, label: 'Platinum GC Enhancer reagent' },
    { pattern: /invitrogen/i, weight: 0.3, label: 'Invitrogen vendor' },
    { pattern: /68\s*°?\s*C/i, weight: 0.2, label: '68°C extension' },
  ],
  'JumpStart REDTaq ReadyMix Reaction Mix': [
    { pattern: /jumpstart/i, weight: 0.6, label: 'JumpStart brand' },
    { pattern: /redtaq/i, weight: 0.6, label: 'REDTaq brand' },
    { pattern: /sigma|aldrich/i, weight: 0.3, label: 'Sigma-Aldrich vendor' },
    { pattern: /betaine/i, weight: 0.2, label: 'Betaine optional additive' },
  ],
  'Agencourt AMPure XP PCR Purification': [
    { pattern: /ampure\s*XP/i, weight: 0.7, label: 'AMPure XP brand' },
    { pattern: /agencourt/i, weight: 0.5, label: 'Agencourt brand' },
    { pattern: /beckman/i, weight: 0.3, label: 'Beckman Coulter vendor' },
    { pattern: /1\.8\s*x.*bead/i, weight: 0.4, label: '1.8x bead ratio' },
    { pattern: /SPRIPlate/i, weight: 0.4, label: 'SPRIPlate equipment' },
  ],
  'MagJET NGS Cleanup and Size Selection Kit': [
    { pattern: /magjet\s*NGS/i, weight: 0.7, label: 'MagJET NGS brand' },
    { pattern: /binding\s*mix/i, weight: 0.5, label: 'Binding Mix reagent' },
    { pattern: /size\s*selection/i, weight: 0.4, label: 'Size selection feature' },
  ],
  'AxyPrep Mag PCR Clean-up': [
    { pattern: /axyprep/i, weight: 0.7, label: 'AxyPrep brand' },
    { pattern: /axygen/i, weight: 0.5, label: 'Axygen vendor' },
    { pattern: /tris.?HCl.*pH\s*8/i, weight: 0.3, label: '10 mM Tris-HCl pH 8 elution buffer' },
  ],
};

function scoreByKeywords(
  text: string,
  protocols: ProtocolSelectedRow[]
): ProtocolMatchCandidate[] {
  return protocols.map<ProtocolMatchCandidate>((p) => {
    const keywords = PROTOCOL_KEYWORDS[p.protocol_name] ?? [];
    let score = 0;
    const reasons: string[] = [];
    for (const kw of keywords) {
      if (kw.pattern.test(text)) {
        score += kw.weight;
        reasons.push(`Document mentions ${kw.label}.`);
      }
    }
    // Cap at 1.0 — multiple weak signals shouldn't blow past a clean vendor hit.
    return {
      protocol_name: p.protocol_name,
      score: Math.min(1, score),
      reasons: reasons.slice(0, 5),
    };
  });
}

function mergeScores(
  a: ProtocolMatchCandidate[],
  b: ProtocolMatchCandidate[]
): ProtocolMatchCandidate[] {
  const byName = new Map<string, ProtocolMatchCandidate>();
  for (const c of [...a, ...b]) {
    const existing = byName.get(c.protocol_name);
    if (!existing) {
      byName.set(c.protocol_name, { ...c, reasons: [...c.reasons] });
      continue;
    }
    // Combine: weighted average favoring the higher signal, dedup reasons.
    const combinedScore = Math.min(1, existing.score * 0.6 + c.score * 0.6);
    const reasons = dedup([...existing.reasons, ...c.reasons]).slice(0, 5);
    byName.set(c.protocol_name, {
      protocol_name: c.protocol_name,
      score: combinedScore,
      reasons,
    });
  }
  return Array.from(byName.values()).sort((x, y) => y.score - x.score);
}

function upsertScore(
  candidates: ProtocolMatchCandidate[],
  name: string,
  score: number,
  reasons: string[]
): ProtocolMatchCandidate[] {
  const idx = candidates.findIndex((c) => c.protocol_name === name);
  const next = [...candidates];
  if (idx === -1) {
    next.push({ protocol_name: name, score, reasons });
  } else {
    next[idx] = {
      protocol_name: name,
      score: Math.max(next[idx].score, score),
      reasons: dedup([...next[idx].reasons, ...reasons]).slice(0, 5),
    };
  }
  return next.sort((a, b) => b.score - a.score);
}

// ----- Tier 3: LLM -----

let _promptTemplate: string | null = null;
function loadPromptTemplate(): string {
  if (_promptTemplate) return _promptTemplate;
  _promptTemplate = readFileSync(
    resolve(process.cwd(), 'lib/llm/prompts/matchProtocol.md'),
    'utf8'
  );
  return _promptTemplate;
}

async function runLlmTier(input: MatchInput) {
  const protocols = loadProtocols();
  const protocolList = protocols
    .map((p) => `- ${p.protocol_name} (${p.vendor}, ${p.family})`)
    .join('\n');
  const prompt = loadPromptTemplate().replace('{{PROTOCOL_LIST}}', protocolList);

  const userBlock =
    `Filename: ${input.filename}\n\n` +
    (input.text_sample
      ? `Document text excerpt:\n"""\n${input.text_sample.slice(0, MAX_TEXT_FOR_LLM)}\n"""`
      : '(No text excerpt provided. The original file is attached.)');

  const attachments =
    !input.text_sample && input.file_bytes
      ? [
          {
            mimeType: input.mime_type ?? 'application/pdf',
            data: input.file_bytes,
          },
        ]
      : undefined;

  return generateJson({
    prompt: `${prompt}\n\n---\n\n${userBlock}`,
    attachments,
    responseSchema: geminiResponseSchemaForMatch(),
    validate: protocolMatchSchema() as never,
    temperature: 0,
  }) as Promise<{ protocol_name: string; confidence: number; reasons: string[] }>;
}

// ----- shared scoring helpers -----

function pickBest(candidates: ProtocolMatchCandidate[]): ProtocolMatchCandidate {
  if (candidates.length === 0) {
    return { protocol_name: '', score: 0, reasons: [] };
  }
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  return sorted[0];
}

function isConfident(candidates: ProtocolMatchCandidate[]): boolean {
  if (candidates.length === 0) return false;
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const top = sorted[0];
  if (top.score < CONFIDENCE_FLOOR) return false;
  const second = sorted[1];
  if (second && top.score - second.score < AMBIGUITY_DELTA) return false;
  return true;
}

function finalize(
  best: ProtocolMatchCandidate,
  matchedVia: ProtocolMatchResult['matched_via'],
  candidates: ProtocolMatchCandidate[],
  notes: string
): ProtocolMatchResult {
  const sorted = [...candidates].sort((a, b) => b.score - a.score).slice(0, 5);
  const valid = best.protocol_name && best.score > 0;
  return {
    protocol_name: valid ? best.protocol_name : null,
    confidence: valid ? best.score : 0,
    matched_via: valid ? matchedVia : 'none',
    candidates: sorted,
    notes,
  };
}

function dedup<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}
