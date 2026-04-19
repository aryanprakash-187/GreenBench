// Build the EPA enrichment cache.
//
// Reads:  data/seed/reagent_term_map.csv
//         data/static/rcra_codes.json
//         data/static/tri_chemicals.csv     (optional)
// Writes: data/epa_cache.json
//
// Run:    npm run epa:build
//         npm run epa:build -- --dry-run
//         npm run epa:build -- --only=phenol_chloroform_isoamyl,methanol
//
// Behavior:
//   - RCRA + TRI are local lookups, always run.
//   - CompTox is hit live. If EPA_CCTE_API_KEY is missing, CompTox lookups are skipped
//     with a warning and the cache is still written so the engine has *something* to
//     read. Re-run once the key arrives to fill in the CompTox blocks.
//   - On every run the entire cache is rebuilt from scratch (deterministic, no drift).

import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';

import {
  CompToxClient,
  PubChemClient,
  RcraClient,
  TriClient,
  saveCache,
} from '../lib/epa/index.js';
import type {
  EpaCacheEntry,
  HazardEntry,
  ReagentMapRow,
} from '../lib/epa/index.js';

interface HazardSource {
  name: 'comptox' | 'pubchem';
  lookup(args: { cas?: string; name?: string }): Promise<HazardEntry>;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const REAGENT_MAP_PATH = resolve(REPO_ROOT, 'data/seed/reagent_term_map.csv');
const RCRA_PATH = resolve(REPO_ROOT, 'data/static/rcra_codes.json');
// TRI: a directory containing one or more CSVs (one per Excel sheet is fine — they're merged).
const TRI_PATH = resolve(REPO_ROOT, 'data/tri_chemicals');
const OUTPUT_PATH = resolve(REPO_ROOT, 'data/epa_cache.json');

const RATE_LIMIT_DELAY_MS = 150;

type SourceChoice = 'auto' | 'comptox' | 'pubchem' | 'none';

function parseArgs(argv: string[]): {
  dryRun: boolean;
  only: Set<string> | null;
  source: SourceChoice;
} {
  let dryRun = false;
  let only: Set<string> | null = null;
  let source: SourceChoice = 'auto';
  for (const a of argv.slice(2)) {
    if (a === '--dry-run') dryRun = true;
    else if (a.startsWith('--only=')) only = new Set(a.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean));
    else if (a.startsWith('--source=')) {
      const v = a.slice('--source='.length).trim();
      if (v === 'comptox' || v === 'pubchem' || v === 'none' || v === 'auto') source = v;
      else throw new Error(`Unknown --source value: ${v}. Use comptox|pubchem|none|auto.`);
    }
  }
  return { dryRun, only, source };
}

function loadReagentMap(path: string): ReagentMapRow[] {
  if (!existsSync(path)) {
    throw new Error(`Reagent map not found at ${path}. Have the data lead drop it there, or use the seeded stub.`);
  }
  const text = readFileSync(path, 'utf8');
  const rows = parse(text, { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
  return rows.map((r) => ({
    raw_term: r.raw_term ?? '',
    normalized_name: r.normalized_name ?? '',
    generic_overlap_group: r.generic_overlap_group ?? '',
    workflow_family: r.workflow_family ?? '',
    stage: r.stage ?? '',
    shareable_prep: r.shareable_prep ?? '',
    hazard_or_handling_flag: r.hazard_or_handling_flag ?? '',
    epa_lookup_key: r.epa_lookup_key ?? '',
    cas: r.cas ?? '',
    protocol_examples: r.protocol_examples ?? '',
  }));
}

interface DedupedReagent {
  row: ReagentMapRow;
  sourceCount: number;
  /** Every distinct raw_term that mapped to this lookup key — used as additional name
   *  fallbacks when querying CompTox / TRI / RCRA. */
  allRawTerms: Set<string>;
}

function dedupeByLookupKey(rows: ReagentMapRow[]): DedupedReagent[] {
  const seen = new Map<string, DedupedReagent>();
  for (const r of rows) {
    if (!r.epa_lookup_key) continue;
    const prev = seen.get(r.epa_lookup_key);
    if (prev) {
      prev.sourceCount += 1;
      if (r.raw_term) prev.allRawTerms.add(r.raw_term);
      if (!prev.row.cas && r.cas) prev.row = { ...r };
    } else {
      seen.set(r.epa_lookup_key, {
        row: r,
        sourceCount: 1,
        allRawTerms: new Set(r.raw_term ? [r.raw_term] : []),
      });
    }
  }
  return [...seen.values()];
}

/** A reagent's chemical-search candidates, in order of likely match quality. */
function searchCandidates(d: DedupedReagent): string[] {
  const out = new Set<string>();
  if (d.row.normalized_name) out.add(d.row.normalized_name);
  for (const rt of d.allRawTerms) out.add(rt);

  // Generate cleaned variants:
  //   - strip leading "fresh", "stock", "diluted", etc.
  //   - strip "<number>%" anywhere
  //   - take the trailing chemical-name token ("fresh 70% ethanol" → "ethanol")
  const STOPWORDS = /\b(fresh|stock|diluted|dilution|sterile|nuclease[-\s]free|molecular[-\s]grade|reagent[-\s]grade|absolute)\b/gi;
  const PCT = /\b\d+\s*%/g;
  for (const v of [...out]) {
    const cleaned = v.replace(STOPWORDS, ' ').replace(PCT, ' ').replace(/\s+/g, ' ').trim();
    if (cleaned && cleaned !== v) out.add(cleaned);
    const tokens = cleaned.split(/\s+/).filter((t) => t.length > 3 && /[a-z]/i.test(t));
    if (tokens.length) out.add(tokens[tokens.length - 1]);
  }
  return [...out].filter(Boolean);
}

function summarize(entry: Omit<EpaCacheEntry, 'summary'>): EpaCacheEntry['summary'] {
  return {
    has_any_hazard_signal:
      (entry.hazard?.ghs_codes.length ?? 0) > 0 ||
      entry.tri.is_listed ||
      entry.rcra.codes.length > 0,
    rcra_code_primary: entry.rcra.codes[0] ?? null,
    is_tri_listed: entry.tri.is_listed,
    ghs_code_count: entry.hazard?.ghs_codes.length ?? 0,
    hazard_source: entry.hazard?.source ?? null,
  };
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

function chooseHazardSource(choice: SourceChoice): HazardSource | null {
  const apiKey = process.env.EPA_CCTE_API_KEY?.trim();

  if (choice === 'none') return null;

  if (choice === 'comptox') {
    if (!apiKey) throw new Error('--source=comptox requires EPA_CCTE_API_KEY in .env.local.');
    return new CompToxClient({ apiKey, baseUrl: process.env.EPA_CCTE_BASE_URL });
  }

  if (choice === 'pubchem') {
    return new PubChemClient();
  }

  // auto: prefer CompTox if a key is configured, otherwise fall back to PubChem.
  if (apiKey) {
    console.log('Using CompTox CCTE for hazard data (EPA_CCTE_API_KEY detected).');
    return new CompToxClient({ apiKey, baseUrl: process.env.EPA_CCTE_BASE_URL });
  }
  console.log('Using PubChem (NIH) for hazard data — no CompTox key configured.');
  console.log('  When your CompTox key arrives, set EPA_CCTE_API_KEY and re-run.');
  return new PubChemClient();
}

async function main() {
  const { dryRun, only, source: sourceChoice } = parseArgs(process.argv);

  console.log('▶ build-epa-cache.ts');
  console.log('  reagent map :', REAGENT_MAP_PATH);
  console.log('  rcra static :', RCRA_PATH);
  console.log('  tri folder  :', TRI_PATH, existsSync(TRI_PATH) ? '' : '(missing — TRI lookups skipped)');
  console.log('  output      :', OUTPUT_PATH, dryRun ? '(dry run, will not write)' : '');
  console.log();

  const allRows = loadReagentMap(REAGENT_MAP_PATH);
  const deduped = dedupeByLookupKey(allRows)
    .filter(({ row }) => (only ? only.has(row.epa_lookup_key) : true));

  if (!deduped.length) {
    console.error('No reagents to process. Exiting.');
    process.exit(1);
  }
  console.log(`Loaded ${allRows.length} rows → ${deduped.length} unique epa_lookup_key entries.`);

  const rcra = new RcraClient(RCRA_PATH);
  const tri = new TriClient(TRI_PATH);
  if (!tri.isFileMissing()) {
    console.log(`TRI: loaded ${tri.totalRows()} chemical rows from ${TRI_PATH}.`);
  }
  const hazardSource = chooseHazardSource(sourceChoice);
  console.log();

  const entries: Record<string, EpaCacheEntry> = {};
  let okCount = 0;
  let warnCount = 0;

  for (const d of deduped) {
    const r = d.row;
    const candidates = searchCandidates(d);
    const lookups: EpaCacheEntry['lookups_used'] = [];
    if (r.cas) lookups.push({ type: 'cas', value: r.cas });
    for (const c of candidates) lookups.push({ type: 'name', value: c });

    const tag = `[${r.epa_lookup_key}]`;
    const fanout = d.sourceCount > 1 ? ` (×${d.sourceCount} raw terms)` : '';
    process.stdout.write(`${tag} ${r.normalized_name || r.raw_term}${fanout} `);

    // RCRA + TRI tolerate a single-shot lookup; we just walk candidates until one hits.
    let rcraEntry = rcra.lookup({ cas: r.cas });
    if (!rcraEntry.codes.length) {
      for (const name of candidates) {
        const hit = rcra.lookup({ name });
        if (hit.codes.length) { rcraEntry = hit; break; }
      }
    }
    let triEntry = tri.lookup({ cas: r.cas });
    if (!triEntry.is_listed) {
      for (const name of candidates) {
        const hit = tri.lookup({ name });
        if (hit.is_listed) { triEntry = hit; break; }
      }
    }

    let hazardEntry: HazardEntry | null = null;
    if (hazardSource) {
      try {
        // Try CAS + first name, then walk further name candidates until something hits.
        hazardEntry = await hazardSource.lookup({ cas: r.cas, name: candidates[0] });
        for (let i = 1; i < candidates.length && !hazardEntry?.external_id; i += 1) {
          hazardEntry = await hazardSource.lookup({ name: candidates[i] });
          await sleep(RATE_LIMIT_DELAY_MS);
        }
        await sleep(RATE_LIMIT_DELAY_MS);
      } catch (err) {
        hazardEntry = {
          source: hazardSource.name,
          external_id: null,
          preferred_name: null,
          ghs_codes: [],
          ghs_phrases: [],
          hazard_categories: [],
          source_url: null,
          fetched_at: new Date().toISOString(),
          error: String(err),
        };
      }
    }

    const partial: Omit<EpaCacheEntry, 'summary'> = {
      epa_lookup_key: r.epa_lookup_key,
      lookups_used: lookups,
      hazard: hazardEntry,
      tri: triEntry,
      rcra: rcraEntry,
    };
    const entry: EpaCacheEntry = { ...partial, summary: summarize(partial) };
    entries[r.epa_lookup_key] = entry;

    const flags = [
      entry.summary.is_tri_listed ? 'TRI' : null,
      entry.summary.rcra_code_primary,
      entry.summary.ghs_code_count
        ? `GHS×${entry.summary.ghs_code_count}(${entry.summary.hazard_source})`
        : null,
    ].filter(Boolean);
    const status = flags.length ? `✓ ${flags.join(' ')}` : '· no hazard signal';
    if (hazardEntry?.error) warnCount += 1;
    else okCount += 1;
    console.log(status);
  }

  console.log();
  console.log(`Done. ${okCount} ok, ${warnCount} with warnings, ${deduped.length} total.`);

  if (tri.isFileMissing()) {
    console.log('  ⚠ TRI static file missing — see data/static/README.md to download it.');
  }

  if (!dryRun) {
    saveCache(OUTPUT_PATH, entries);
    console.log(`Wrote ${OUTPUT_PATH}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
