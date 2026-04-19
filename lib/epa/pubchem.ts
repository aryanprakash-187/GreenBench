// PubChem (NIH) hazard lookup. Free, no API key, generous rate limits.
//
// Used as the default hazard source until/unless EPA_CCTE_API_KEY is set.
//
// Two-step query:
//   1. Resolve a chemical name (or CAS) to a PubChem CID.
//        GET /rest/pug/compound/name/{name}/cids/JSON
//        GET /rest/pug/compound/xref/RegistryID/{cas}/cids/JSON   (CAS variant)
//   2. Pull the GHS Classification section for that CID.
//        GET /rest/pug_view/data/compound/{cid}/JSON?heading=GHS+Classification
//
// The GHS section is a deeply nested JSON tree. The strings we want look like:
//   "H301: Toxic if swallowed [Danger Acute toxicity, oral - Category 3]"
// We extract the H-code and the human-readable phrase from each, and collect the
// "Danger" / "Warning" signal word as a hazard category.
//
// PubChem rate limits: 5 req/sec, 400 req/min. The build script paces itself.

import type { HazardEntry } from './types.js';

const PUBCHEM_BASE = 'https://pubchem.ncbi.nlm.nih.gov';
const COMPOUND_PAGE = 'https://pubchem.ncbi.nlm.nih.gov/compound';

interface CidsResponse {
  IdentifierList?: { CID?: number[] };
}

interface PugViewResponse {
  Record?: {
    RecordTitle?: string;
    Section?: PugViewSection[];
  };
}

interface PugViewSection {
  TOCHeading?: string;
  Section?: PugViewSection[];
  Information?: {
    Value?: { StringWithMarkup?: { String?: string }[] };
  }[];
}

export interface PubChemClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  /** User-Agent header — PubChem asks scripts to identify themselves. */
  userAgent?: string;
}

export class PubChemClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(opts: PubChemClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? PUBCHEM_BASE).replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.userAgent =
      opts.userAgent ??
      'BenchGreen-EPA-Enrichment/0.1 (hackathon project; contact via repo)';
  }

  async lookup(args: { cas?: string; name?: string }): Promise<HazardEntry> {
    const fetchedAt = new Date().toISOString();
    const empty: HazardEntry = {
      source: 'pubchem',
      external_id: null,
      preferred_name: null,
      ghs_codes: [],
      ghs_phrases: [],
      hazard_categories: [],
      source_url: null,
      fetched_at: fetchedAt,
    };

    let cid: number | null = null;
    try {
      if (args.cas) cid = await this.resolveCidByCas(args.cas);
      if (cid == null && args.name) cid = await this.resolveCidByName(args.name);
    } catch (err) {
      return { ...empty, error: `cid resolution failed: ${String(err)}` };
    }

    if (cid == null) {
      return { ...empty, error: 'no PubChem CID match' };
    }

    let view: PugViewResponse | null = null;
    try {
      view = await this.getGhsView(cid);
    } catch (err) {
      return {
        ...empty,
        external_id: String(cid),
        source_url: `${COMPOUND_PAGE}/${cid}`,
        error: `ghs fetch failed: ${String(err)}`,
      };
    }

    const ghsStrings = this.collectGhsStrings(view);
    const codes = new Set<string>();
    const phrases = new Set<string>();
    const categories = new Set<string>();

    for (const s of ghsStrings) {
      // Match "H301", "H314", "P102" etc. (we only care about H-codes for now).
      const codeMatch = s.match(/\bH\d{3}[A-Za-z]?\b/);
      if (codeMatch) codes.add(codeMatch[0]);

      // Phrase between the code and the bracketed metadata.
      const phraseMatch = s.match(/H\d{3}[A-Za-z]?\s*:\s*(.+?)(?:\s*\[|$)/);
      if (phraseMatch && phraseMatch[1]) phrases.add(phraseMatch[1].trim());

      // Signal word + category cue inside the brackets.
      if (/\[Danger\b/i.test(s)) categories.add('signal:danger');
      if (/\[Warning\b/i.test(s)) categories.add('signal:warning');

      // Hazard class cue (e.g. "Acute toxicity, oral - Category 3").
      const classMatch = s.match(/\[(?:Danger|Warning)\s+([^\]]+?)\s*-\s*Category/i);
      if (classMatch && classMatch[1]) categories.add(classMatch[1].trim().toLowerCase());
    }

    return {
      source: 'pubchem',
      external_id: String(cid),
      preferred_name: view?.Record?.RecordTitle ?? null,
      ghs_codes: [...codes].sort(),
      ghs_phrases: [...phrases],
      hazard_categories: [...categories].sort(),
      source_url: `${COMPOUND_PAGE}/${cid}`,
      fetched_at: fetchedAt,
    };
  }

  private async resolveCidByName(name: string): Promise<number | null> {
    const path = `/rest/pug/compound/name/${encodeURIComponent(name)}/cids/JSON`;
    const data = await this.get<CidsResponse>(path);
    return data?.IdentifierList?.CID?.[0] ?? null;
  }

  private async resolveCidByCas(cas: string): Promise<number | null> {
    // PubChem treats CAS as a registry ID xref.
    const path = `/rest/pug/compound/xref/RegistryID/${encodeURIComponent(cas)}/cids/JSON`;
    const data = await this.get<CidsResponse>(path);
    return data?.IdentifierList?.CID?.[0] ?? null;
  }

  private async getGhsView(cid: number): Promise<PugViewResponse | null> {
    const path = `/rest/pug_view/data/compound/${cid}/JSON?heading=GHS+Classification`;
    return this.get<PugViewResponse>(path);
  }

  private collectGhsStrings(view: PugViewResponse | null): string[] {
    const out: string[] = [];
    const walk = (sections?: PugViewSection[]): void => {
      if (!sections) return;
      for (const s of sections) {
        if (s.Information) {
          for (const info of s.Information) {
            const swm = info.Value?.StringWithMarkup;
            if (!swm) continue;
            for (const item of swm) {
              if (item.String) out.push(item.String);
            }
          }
        }
        walk(s.Section);
      }
    };
    walk(view?.Record?.Section);
    return out;
  }

  private async get<T>(path: string): Promise<T | null> {
    const url = `${this.baseUrl}${path}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': this.userAgent, accept: 'application/json' },
        signal: ctrl.signal,
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`PubChem ${res.status} on ${path}: ${body.slice(0, 200)}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(t);
    }
  }
}
