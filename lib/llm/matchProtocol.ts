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
  FLASH_LITE_MODEL,
  generateJson,
  llmAvailability,
  LlmClientError,
} from './client';
import {
  geminiResponseSchemaForMatch,
  protocolMatchSchema,
} from './schemas';

const CONFIDENCE_FLOOR = 0.5;  // below this we don't fully trust the match
const AMBIGUITY_DELTA = 0.1;   // top two scores within this band -> ambiguous
const MAX_TEXT_FOR_KEYWORDS = 8_000;
// 2 KB is plenty of context for a single-class identify call (cover page +
// first TOC entry). Cutting this down keeps p95 matcher latency under ~3 s
// even on the LLM path.
const MAX_TEXT_FOR_LLM = 2_000;
// Matcher is a single-object classification — Flash-Lite is fast and has a
// more generous free-tier quota (1000 RPD) than full Flash.
const MATCHER_MODEL = FLASH_LITE_MODEL;
// 15 s is a hard ceiling covering one happy-path round trip. We never retry
// the matcher (maxAttempts=1) — the deterministic tiers always give us a
// viable fallback, so burning another 15 s on a flaky LLM is wasted wall time.
const MATCHER_TIMEOUT_MS = 15_000;
const MATCHER_MAX_ATTEMPTS = 1;

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
      const raw = err instanceof LlmClientError ? err.message : (err as Error).message;
      const friendly = humanizeLlmFailure(raw);
      return finalize(best, 'keyword', filenameScores, friendly);
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

/** Per-protocol aliases. Key is the canonical protocol_name (must match
 *  protocols_selected.csv exactly); values are alternate strings the user
 *  might have in their filename (vendor names, product codes, SKUs, common
 *  shorthand). Case-insensitive substring match. Scored by alias length, so
 *  more-specific (longer) aliases outweigh short/generic ones automatically.
 *
 *  IMPORTANT: Aliases are ordered from most-specific to most-generic. Add new
 *  aliases here when a real upload fails to match — keep this table in sync
 *  with /data/seed/protocols_selected.csv whenever that file changes. */
const PROTOCOL_ALIASES: Record<string, string[]> = {
  // Agencourt AMPure XP — 96-well plate variant (the common case / default
  // when filename just says "ampure xp" without a plate-format hint).
  'Agencourt AMPure XP PCR Purification (96-well)': [
    'agencourt ampure xp 96',
    'ampure xp 96 well',
    'ampure xp 96-well',
    'ampure xp 96well',
    'ampure xp 96',
    'ampure 96 well',
    'ampure 96well',
    'beckman ampure xp',
    'agencourt ampure xp',
    'ampure xp',
    'agencourt ampure',
    'beckman coulter',
    'beckman',
    'agencourt',
    'ampure',
    'a63881',
    'a63880',
  ],
  // Agencourt AMPure XP — 384-well variant. Only fires when the filename has
  // an explicit 384 disambiguator, otherwise 96-well's longer aliases win.
  'Agencourt AMPure XP PCR Purification (384-well)': [
    'agencourt ampure xp 384',
    'ampure xp 384 well',
    'ampure xp 384-well',
    'ampure xp 384well',
    'ampure xp 384',
    'ampure 384 well',
    'ampure 384well',
    'ampure 384',
    '384 well ampure',
    '384 well spri',
    'a63882',
  ],
  // KAPA Pure Beads 3X genomic DNA cleanup — the standard KAPA bead workflow.
  'KAPA Pure Beads Genomic DNA Cleanup (3X)': [
    'kapa pure beads genomic dna',
    'kapa pure beads gdna',
    'kapa pure beads 3x',
    'kapa pure beads cleanup',
    'kapa pure beads',
    'kapa pure 3x',
    'kapa genomic dna cleanup',
    'kapa gdna cleanup',
    'roche kapa pure',
    'roche kapa',
    'kk8000',
    'kk8001',
    '07983271001',
  ],
  // KAPA Pure Beads Dual Size Selection (the specialty variant).
  'KAPA Pure Beads Dual Size Selection (0.6X/0.8X)': [
    'kapa pure beads dual size selection',
    'kapa dual size selection',
    'kapa size selection',
    'kapa pure dual size',
    'kapa pure 0.6x 0.8x',
    'kapa dual size',
    '0.6x/0.8x',
    '0.6x 0.8x',
    'dual size selection',
  ],
  // KAPA HyperPure Beads — the HyperPure variant (distinct SKU line).
  'KAPA HyperPure Beads Genomic DNA Cleanup (3X)': [
    'kapa hyperpure beads genomic',
    'kapa hyperpure beads',
    'kapa hyperpure 3x',
    'hyperpure beads',
    'kapa hyperpure',
    'hyperpure',
    'kk8210',
    'kk8211',
  ],
  // MagJET NGS Cleanup Protocol A — single-cleanup workflow. Thermo publishes
  // ONE user guide (MAN0012957) covering both Protocol A and Protocol B, so
  // we default to Protocol A when the filename doesn't tilt toward B
  // (i.e. no "adapter", "dimer", or explicit "protocol b" token).
  'MagJET NGS Cleanup Protocol A': [
    'magjet ngs cleanup protocol a',
    'magjet ngs protocol a',
    'magjet cleanup protocol a',
    'magjet ngs cleanup a',
    'magjet ngs cleanup',
    'magjet cleanup',
    'magjet ngs',
    'thermo magjet ngs',
    'thermo magjet',
    'magjet',
    'man0012957',
    'k2821',
  ],
  // MagJET NGS Adapter Removal Protocol B — size-selection / adapter-dimer
  // removal. Fires when the filename explicitly signals size selection or
  // adapter removal, which outweighs the generic "magjet ngs" alias.
  'MagJET NGS Adapter Removal Protocol B': [
    'magjet ngs adapter removal protocol b',
    'magjet ngs adapter removal',
    'magjet ngs protocol b',
    'magjet adapter removal',
    'magjet size selection',
    'magjet cleanup protocol b',
    'magjet ngs size selection',
    'adapter dimer removal',
    'adapter removal',
    'adapter dimer',
  ],
  // NucleoMag NGS Single Cleanup — MACHEREY-NAGEL.
  'NucleoMag NGS Single Cleanup (1.0X)': [
    'nucleomag ngs single cleanup',
    'nucleomag ngs cleanup',
    'nucleomag single cleanup',
    'nucleomag ngs',
    'macherey nagel nucleomag',
    'macherey-nagel nucleomag',
    'nucleomag',
    'macherey nagel',
    'macherey-nagel',
    'machereynagel',
    '744970',
  ],
  // Zymo Select-a-Size Left-Sided Cleanup.
  'Select-a-Size Left-Sided Cleanup (300 bp peak)': [
    'zymo select a size left sided cleanup',
    'select-a-size left-sided cleanup',
    'select a size left sided',
    'select-a-size',
    'select a size',
    'selectasize',
    'zymo select a size',
    'zymo select',
    'zymo research',
    'left-sided cleanup',
    'left sided cleanup',
    '300 bp peak',
    'zymo',
    'd4080',
    'd4081',
  ],

  // ---------- DNA_extraction (3) ----------

  // QIAGEN DNeasy 96 Blood & Tissue — spin-column 96-well gDNA extraction.
  // Handles both product-centric filenames ("DNeasy 96 Handbook.pdf") and
  // the vendor-catalog filename we ship with the demo bundle
  // ("DNA Extraction - QIAGEN.pdf").
  'DNeasy 96 Blood & Tissue (Demo 96-well)': [
    'dneasy 96 blood and tissue',
    'dneasy 96 blood tissue',
    'dneasy blood and tissue',
    'dneasy blood tissue',
    'qiagen dneasy 96',
    'qiagen blood and tissue',
    'qiagen blood tissue',
    'qiagen dna extraction',
    'dna extraction qiagen',
    'dneasy handbook',
    'dneasy 96 well',
    'dneasy 96',
    'qiagen dneasy',
    'qiagen genomic dna',
    'qiagen gdna',
    'dneasy',
    'qiagen',
    '69504',
    '69506',
    '69581',
    '69582',
  ],

  // Thermo GeneJET Genomic DNA Purification (high-throughput variant).
  // Vendor token is "Thermofisher" (no space) in the shipped PDF filename
  // — keep both spaced and unspaced variants as aliases. Must outrank the
  // MagJET Genomic entry via a longer, more specific alias.
  'GeneJET Genomic DNA Purification (Demo high-throughput)': [
    'genejet genomic dna purification mini kit',
    'genejet genomic dna purification',
    'genejet genomic dna mini kit',
    'genejet genomic dna kit',
    'genejet genomic dna',
    'genejet whole blood',
    'genejet blood',
    'genejet genomic',
    'thermo fisher genejet',
    'thermofisher genejet',
    'thermo genejet',
    'genejet purification',
    'genejet dna',
    'genejet',
    'dna extraction thermofisher',
    'thermofisher dna extraction',
    'thermo fisher dna extraction',
    'k0721',
    'k0722',
  ],

  // Thermo MagJET Genomic DNA Kit Protocol A — the KingFisher Flex 96
  // automation workflow. Disambiguated from the MagJET NGS protocols by the
  // "genomic" token; "kingfisher" is the other strong cue. The catalog code
  // K1031/K1032 is distinct from the NGS K2821.
  'MagJET Genomic DNA Kit Protocol A (KingFisher Flex 96)': [
    'magjet genomic dna kit protocol a',
    'magjet genomic dna kit kingfisher',
    'magjet genomic dna kit',
    'magjet genomic dna',
    'magjet genomic protocol a',
    'magjet genomic',
    'kingfisher flex 96',
    'kingfisher flex',
    'magjet kingfisher',
    'dna extraction thermo scientific',
    'thermo scientific dna extraction',
    'thermo scientific magjet',
    'k1031',
    'k1032',
  ],

  // ---------- PCR (3) ----------

  // NEB Q5 Hot Start High-Fidelity 2X Master Mix.
  'Q5 Hot Start High-Fidelity 2X Master Mix (Demo 96-well)': [
    'q5 hot start high fidelity 2x master mix',
    'q5 hot start high-fidelity 2x master mix',
    'q5 hot start high fidelity master mix',
    'q5 hot start high-fidelity master mix',
    'q5 high fidelity master mix',
    'q5 hot start master mix',
    'q5 2x master mix',
    'q5 master mix',
    'q5 high fidelity',
    'q5 high-fidelity',
    'q5 hot start',
    'q5 hot-start',
    'neb q5 hot start',
    'new england biolabs q5',
    'new england biolabs',
    'neb q5',
    'pcr new england biolabs',
    'pcr neb',
    'neb pcr',
    'q5',
    'neb',
    'm0494',
    'm0493',
    'm0515',
  ],

  // Invitrogen Platinum II Hot-Start Green PCR Master Mix.
  'Platinum II Hot-Start Green PCR Master Mix (Demo 96-well)': [
    'platinum ii hot start green pcr master mix',
    'platinum ii hot-start green pcr master mix',
    'platinum ii hot start green master mix',
    'platinum ii hot-start green master mix',
    'platinum ii green pcr master mix',
    'platinum ii green master mix',
    'platinum ii hot start green',
    'platinum ii hot-start green',
    'platinum ii pcr master mix',
    'platinum ii master mix',
    'platinum ii green pcr',
    'platinum ii green',
    'platinum ii hot start',
    'platinum ii hot-start',
    'platinum ii',
    'platinumii',
    'invitrogen platinum ii',
    'invitrogen platinum',
    'pcr invitrogen',
    'invitrogen pcr',
    'invitrogen',
    '14001012',
    '14001013',
    '14001014',
  ],

  // Sigma-Aldrich JumpStart REDTaq ReadyMix.
  'JumpStart REDTaq ReadyMix (Demo 96-well)': [
    'jumpstart redtaq readymix',
    'jumpstart redtaq ready mix',
    'jumpstart red taq readymix',
    'jumpstart red taq ready mix',
    'jumpstart redtaq',
    'jumpstart red taq',
    'redtaq readymix',
    'redtaq ready mix',
    'red taq readymix',
    'jumpstart readymix',
    'jumpstart ready mix',
    'redtaq',
    'red taq',
    'sigma aldrich jumpstart',
    'sigma-aldrich jumpstart',
    'sigma aldrich redtaq',
    'sigma-aldrich redtaq',
    'sigma jumpstart',
    'sigma redtaq',
    'pcr sigma aldrich',
    'pcr sigma-aldrich',
    'sigma aldrich pcr',
    'sigma pcr',
    'pcr sigma',
    'jumpstart',
    'p0982',
    'p0600',
    'p0750',
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

/** Score = max aliasLength / 20, capped at 1. An alias ≥ 20 chars gets full
 *  credit; shorter aliases scale linearly. Chosen empirically so a typical
 *  product-name alias (15–25 chars) clears the 0.5 confidence floor without
 *  a single generic alias like "zymo" (4 chars, score 0.2) ever doing so.
 *  Keeps the floor stable regardless of how noisy the filename is. */
function scoreByFilename(
  filename: string,
  protocols: ProtocolSelectedRow[]
): ProtocolMatchCandidate[] {
  const { split, compact } = normalizeFilename(filename);
  return protocols.map<ProtocolMatchCandidate>((p) => {
    const aliases = PROTOCOL_ALIASES[p.protocol_name] ?? [];
    // Full canonical name is always checked too, with high weight when the
    // filename somehow contains it verbatim.
    const candidates = [p.protocol_name.toLowerCase(), ...aliases.map((a) => a.toLowerCase())];

    let bestScore = 0;
    let bestAlias = '';
    const matchedAliases: string[] = [];
    for (const c of candidates) {
      if (split.includes(c) || compact.includes(c)) {
        matchedAliases.push(c);
        const score = Math.min(1, c.length / 20);
        if (score > bestScore) {
          bestScore = score;
          bestAlias = c;
        }
      }
    }

    const reasons: string[] = [];
    if (bestAlias) {
      reasons.push(`Filename contains "${bestAlias}".`);
      // Corroborating alias hits — report up to two more so the UI "why this
      // match?" expander shows the evidence, but they don't inflate score.
      for (const a of matchedAliases) {
        if (a !== bestAlias && reasons.length < 3) {
          reasons.push(`Filename also contains "${a}".`);
        }
      }
    }
    return { protocol_name: p.protocol_name, score: bestScore, reasons };
  });
}

// ----- Tier 2: keyword scan -----

/** Per-protocol weighted keywords for in-document scanning. Biased toward
 *  brand + product cues (high weight) with technique tokens as corroboration.
 *  Weights accumulate but cap at 1.0, so one strong brand hit (0.7) plus a
 *  technique hit (0.3) clears the 0.5 floor cleanly. Keep aligned with
 *  protocols_selected.csv + protocol_reagents.csv. */
const PROTOCOL_KEYWORDS: Record<string, Array<{ pattern: RegExp; weight: number; label: string }>> = {
  'Agencourt AMPure XP PCR Purification (96-well)': [
    { pattern: /ampure\s*xp/i, weight: 0.55, label: 'AMPure XP product name' },
    { pattern: /\bagencourt\b/i, weight: 0.35, label: 'Agencourt brand' },
    { pattern: /beckman/i, weight: 0.25, label: 'Beckman Coulter vendor' },
    { pattern: /96[\s-]?well/i, weight: 0.35, label: '96-well plate format' },
    { pattern: /\bspri(plate)?\b/i, weight: 0.25, label: 'SPRI cleanup technique' },
    { pattern: /1\.8\s*x.*bead/i, weight: 0.25, label: '1.8× bead ratio (amplicon cleanup)' },
  ],
  'Agencourt AMPure XP PCR Purification (384-well)': [
    { pattern: /ampure\s*xp/i, weight: 0.4, label: 'AMPure XP product name' },
    { pattern: /\bagencourt\b/i, weight: 0.3, label: 'Agencourt brand' },
    { pattern: /384[\s-]?well/i, weight: 0.6, label: '384-well plate format' },
    { pattern: /spri.*384|384.*spri/i, weight: 0.3, label: '384-well SPRI format' },
  ],
  'KAPA Pure Beads Genomic DNA Cleanup (3X)': [
    { pattern: /kapa\s*pure\s*beads/i, weight: 0.7, label: 'KAPA Pure Beads product' },
    { pattern: /kapa\s+(genomic|gdna)/i, weight: 0.4, label: 'KAPA genomic DNA cleanup' },
    { pattern: /\bkapa\b/i, weight: 0.25, label: 'KAPA brand' },
    { pattern: /\broche\b/i, weight: 0.2, label: 'Roche vendor' },
    { pattern: /3\s*x|3\.0\s*x/i, weight: 0.2, label: '3× bead ratio (gDNA cleanup)' },
  ],
  'KAPA Pure Beads Dual Size Selection (0.6X/0.8X)': [
    { pattern: /kapa\s*pure\s*beads/i, weight: 0.45, label: 'KAPA Pure Beads product' },
    { pattern: /dual\s*size\s*selection/i, weight: 0.6, label: 'dual-sided size selection' },
    { pattern: /0\.6\s*x/i, weight: 0.3, label: '0.6× bead ratio (left bound)' },
    { pattern: /0\.8\s*x/i, weight: 0.3, label: '0.8× bead ratio (right bound)' },
  ],
  'KAPA HyperPure Beads Genomic DNA Cleanup (3X)': [
    { pattern: /hyperpure/i, weight: 0.75, label: 'HyperPure product name' },
    { pattern: /kapa\s*hyperpure/i, weight: 0.85, label: 'KAPA HyperPure product' },
    { pattern: /\bkapa\b/i, weight: 0.2, label: 'KAPA brand' },
  ],
  'MagJET NGS Cleanup Protocol A': [
    { pattern: /magjet\s*ngs/i, weight: 0.55, label: 'MagJET NGS product' },
    { pattern: /protocol\s*a\b/i, weight: 0.4, label: 'Protocol A (single cleanup)' },
    { pattern: /\bmagjet\b/i, weight: 0.25, label: 'MagJET brand' },
    { pattern: /\bthermo\b/i, weight: 0.2, label: 'Thermo Scientific vendor' },
    { pattern: /man0012957/i, weight: 0.6, label: 'Thermo MAN0012957 document ID' },
    { pattern: /\bk2821\b/i, weight: 0.6, label: 'Thermo K2821 catalog number' },
    { pattern: /binding\s*buffer|binding\s*mix/i, weight: 0.2, label: 'Binding buffer/mix reagent' },
  ],
  'MagJET NGS Adapter Removal Protocol B': [
    { pattern: /magjet\s*ngs/i, weight: 0.4, label: 'MagJET NGS product' },
    { pattern: /adapter\s*(removal|dimer)/i, weight: 0.65, label: 'Adapter removal / dimer step' },
    { pattern: /protocol\s*b\b/i, weight: 0.55, label: 'Protocol B (adapter removal)' },
    { pattern: /size\s*selection/i, weight: 0.3, label: 'Size selection step' },
  ],
  'NucleoMag NGS Single Cleanup (1.0X)': [
    { pattern: /nucleomag/i, weight: 0.75, label: 'NucleoMag product name' },
    { pattern: /macherey[\s-]?nagel/i, weight: 0.5, label: 'MACHEREY-NAGEL vendor' },
    { pattern: /\bmn\s+beads?\b/i, weight: 0.3, label: 'MN Beads reagent' },
    { pattern: /1\.0\s*x|single\s*cleanup/i, weight: 0.2, label: '1.0× single-cleanup ratio' },
  ],
  'Select-a-Size Left-Sided Cleanup (300 bp peak)': [
    { pattern: /select[\s-]?a[\s-]?size/i, weight: 0.75, label: 'Select-a-Size product' },
    { pattern: /left[\s-]?sided/i, weight: 0.4, label: 'Left-sided cleanup' },
    { pattern: /300\s*bp/i, weight: 0.3, label: '300 bp size peak' },
    { pattern: /zymo/i, weight: 0.35, label: 'Zymo Research vendor' },
  ],

  // ---------- DNA_extraction ----------

  'DNeasy 96 Blood & Tissue (Demo 96-well)': [
    { pattern: /dneasy\s*96/i, weight: 0.75, label: 'DNeasy 96 product name' },
    { pattern: /\bdneasy\b/i, weight: 0.55, label: 'DNeasy product line' },
    { pattern: /qiagen/i, weight: 0.3, label: 'QIAGEN vendor' },
    { pattern: /blood\s*(&|and)\s*tissue/i, weight: 0.35, label: 'Blood & Tissue kit' },
    { pattern: /spin[\s-]?column/i, weight: 0.2, label: 'Spin-column extraction' },
    { pattern: /\b69504\b|\b69581\b|\b69582\b/i, weight: 0.6, label: 'QIAGEN DNeasy catalog number' },
  ],

  'GeneJET Genomic DNA Purification (Demo high-throughput)': [
    { pattern: /genejet\s+genomic\s+dna/i, weight: 0.8, label: 'GeneJET Genomic DNA product' },
    { pattern: /genejet\s+genomic/i, weight: 0.7, label: 'GeneJET Genomic kit' },
    { pattern: /\bgenejet\b/i, weight: 0.55, label: 'GeneJET product line' },
    { pattern: /thermo\s*fisher|thermofisher/i, weight: 0.25, label: 'Thermo Fisher vendor' },
    { pattern: /\bk0721\b|\bk0722\b/i, weight: 0.6, label: 'GeneJET K0721/K0722 catalog number' },
  ],

  'MagJET Genomic DNA Kit Protocol A (KingFisher Flex 96)': [
    { pattern: /magjet\s+genomic\s+dna/i, weight: 0.8, label: 'MagJET Genomic DNA product' },
    { pattern: /magjet\s+genomic/i, weight: 0.7, label: 'MagJET Genomic kit' },
    { pattern: /kingfisher\s*flex/i, weight: 0.6, label: 'KingFisher Flex platform' },
    { pattern: /kingfisher/i, weight: 0.35, label: 'KingFisher automation' },
    { pattern: /\bk1031\b|\bk1032\b/i, weight: 0.6, label: 'MagJET Genomic K1031/K1032 catalog number' },
    { pattern: /protocol\s*a\b/i, weight: 0.2, label: 'Protocol A reference' },
  ],

  // ---------- PCR ----------

  'Q5 Hot Start High-Fidelity 2X Master Mix (Demo 96-well)': [
    { pattern: /q5\s*hot[\s-]?start/i, weight: 0.7, label: 'Q5 Hot Start product' },
    { pattern: /q5\s*high[\s-]?fidelity/i, weight: 0.65, label: 'Q5 High-Fidelity polymerase' },
    { pattern: /q5\s*.{0,20}master\s*mix/i, weight: 0.6, label: 'Q5 Master Mix' },
    { pattern: /\bq5\b/i, weight: 0.35, label: 'Q5 polymerase brand' },
    { pattern: /new\s*england\s*biolabs/i, weight: 0.45, label: 'New England Biolabs vendor' },
    { pattern: /\bneb\b/i, weight: 0.3, label: 'NEB vendor' },
    { pattern: /\bm0494\b|\bm0493\b|\bm0515\b/i, weight: 0.6, label: 'NEB Q5 catalog number' },
  ],

  'Platinum II Hot-Start Green PCR Master Mix (Demo 96-well)': [
    { pattern: /platinum\s*(ii|2)\s*hot[\s-]?start\s*green/i, weight: 0.85, label: 'Platinum II Hot-Start Green' },
    { pattern: /platinum\s*(ii|2)\s*green/i, weight: 0.75, label: 'Platinum II Green master mix' },
    { pattern: /platinum\s*(ii|2)/i, weight: 0.55, label: 'Platinum II polymerase' },
    { pattern: /invitrogen/i, weight: 0.4, label: 'Invitrogen vendor' },
    { pattern: /hot[\s-]?start\s*green/i, weight: 0.35, label: 'Hot-Start Green chemistry' },
    { pattern: /\b14001012\b|\b14001013\b|\b14001014\b/i, weight: 0.6, label: 'Invitrogen Platinum II catalog number' },
  ],

  'JumpStart REDTaq ReadyMix (Demo 96-well)': [
    { pattern: /jumpstart\s*red[\s-]?taq\s*ready[\s-]?mix/i, weight: 0.85, label: 'JumpStart REDTaq ReadyMix' },
    { pattern: /jumpstart\s*red[\s-]?taq/i, weight: 0.75, label: 'JumpStart REDTaq' },
    { pattern: /\bjumpstart\b/i, weight: 0.5, label: 'JumpStart product line' },
    { pattern: /red[\s-]?taq\s*ready[\s-]?mix/i, weight: 0.65, label: 'REDTaq ReadyMix' },
    { pattern: /\bred[\s-]?taq\b/i, weight: 0.45, label: 'REDTaq polymerase' },
    { pattern: /sigma[\s-]?aldrich/i, weight: 0.35, label: 'Sigma-Aldrich vendor' },
    { pattern: /\bp0982\b|\bp0600\b|\bp0750\b/i, weight: 0.6, label: 'Sigma JumpStart REDTaq catalog number' },
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
    // Combine signals: trust the stronger one, then add a half-credit
    // bonus from the weaker corroborating signal. This means a confident
    // filename hit (1.0) is never *downgraded* by a silent keyword scan
    // (0), and two weak signals (0.4 + 0.4) still beat a single weak
    // signal alone (0.4 -> 0.6). Capped at 1.0.
    const hi = Math.max(existing.score, c.score);
    const lo = Math.min(existing.score, c.score);
    const combinedScore = Math.min(1, hi + 0.5 * lo);
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
    model: MATCHER_MODEL,
    timeoutMs: MATCHER_TIMEOUT_MS,
    temperature: 0,
    // No retries: the deterministic tiers always give us a viable fallback, so
    // burning another 15 s on a flaky LLM just wastes wall time for the user.
    maxAttempts: MATCHER_MAX_ATTEMPTS,
  }) as Promise<{ protocol_name: string; confidence: number; reasons: string[] }>;
}

/** Translate the SDK's raw error dump into a one-line, human-readable note
 *  that's safe to show in the UI. Falls back to the deterministic best guess
 *  in every case — the LLM failure itself is not fatal. */
function humanizeLlmFailure(raw: string): string {
  const m = raw ?? '';
  if (/document has no pages|Unable to process input image|Invalid PDF/i.test(m)) {
    return "Couldn't read the uploaded PDF (looks scanned, encrypted, or not a standard PDF). Used the filename only.";
  }
  if (/\b400\b.*(Bad Request|Invalid argument)/i.test(m)) {
    return 'The uploaded file could not be parsed by the LLM. Used the filename only.';
  }
  if (/\b401\b|\b403\b|API key|permission|unauthenticated/i.test(m)) {
    return 'The Gemini API key is missing or invalid. Set GEMINI_API_KEY in .env.local and restart the dev server.';
  }
  if (/\b429\b|quota|rate/i.test(m)) {
    return 'Gemini rate limit hit. Try again in a moment; using the deterministic guess for now.';
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(m)) {
    return 'Could not reach Gemini right now (network). Using the deterministic guess instead.';
  }
  if (/TIMEOUT|timed out|aborted/i.test(m)) {
    return 'Gemini took too long to respond. Using the deterministic guess instead.';
  }
  return 'LLM tiebreaker unavailable — using the deterministic guess instead.';
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

/** Wrap up a match result. Critical contract:
 *  `protocol_name` is NEVER null when the catalog is non-empty. If no tier
 *  produced any signal at all, we default to the first catalog entry with
 *  low confidence + an explicit "please confirm" note so the UI can surface
 *  a match card (which is editable via the dropdown) instead of throwing a
 *  hard error. This is the "PDFs have to work no matter what" guarantee.
 */
function finalize(
  best: ProtocolMatchCandidate,
  matchedVia: ProtocolMatchResult['matched_via'],
  candidates: ProtocolMatchCandidate[],
  notes: string
): ProtocolMatchResult {
  const sorted = [...candidates].sort((a, b) => b.score - a.score).slice(0, 5);
  const hasSignal = Boolean(best.protocol_name) && best.score > 0;
  if (hasSignal) {
    return {
      protocol_name: best.protocol_name,
      confidence: best.score,
      matched_via: matchedVia,
      candidates: sorted,
      notes,
    };
  }

  // Zero-signal fallback — pick a sensible default from the catalog so the
  // downstream hydrate + plan flow always succeeds. The user can override via
  // the UI dropdown. Confidence stays at 0 so the UI can badge it clearly.
  const fallback = pickDefaultProtocol();
  if (!fallback) {
    // Catalog is empty (shouldn't happen in practice; seed bundle always has 9).
    return {
      protocol_name: null,
      confidence: 0,
      matched_via: 'none',
      candidates: sorted,
      notes,
    };
  }

  const defaultedNote =
    `Couldn't confidently identify the protocol — defaulted to "${fallback}". ` +
    'Please pick the right one from the dropdown if this is wrong. ' +
    `(${notes})`;
  const existing = sorted.find((c) => c.protocol_name === fallback);
  const candidatesOut = existing
    ? sorted
    : [
        {
          protocol_name: fallback,
          score: 0,
          reasons: ['Defaulted to catalog entry after deterministic + LLM tiers yielded no signal.'],
        },
        ...sorted,
      ].slice(0, 5);
  return {
    protocol_name: fallback,
    confidence: 0,
    matched_via: 'none',
    candidates: candidatesOut,
    notes: defaultedNote,
  };
}

/** Pick the first catalog protocol. Stable default so the UI never blocks on
 *  a null match; the user can always override via the dropdown. */
function pickDefaultProtocol(): string | null {
  const protocols = loadProtocols();
  if (protocols.length === 0) return null;
  return protocols[0].protocol_name;
}

function dedup<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}
