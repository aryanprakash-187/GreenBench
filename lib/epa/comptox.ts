// EPA CompTox CCTE API client.
//
// Docs / Swagger:    https://api-ccte.epa.gov/docs
// Auth:              `x-api-key` header. Request a key by emailing ccte_api@epa.gov
//                    (fallback: ccte-api-support@epa.gov).
// Rate limits:       generous for hackathon use (~hundreds of req/min). The build script
//                    adds a small delay between calls so we stay polite.
//
// IMPORTANT: the exact URL paths under /chemical, /hazard, and /ghs have shifted between
// CCTE API versions. The constants below are the paths that work as of writing — if a call
// comes back 404 from the live API, open the Swagger UI above and adjust the path strings.
// Everything else (request/response handling, retry, error reporting) stays the same.

import type { HazardEntry } from './types.js';

const DEFAULT_BASE_URL = 'https://api-ccte.epa.gov';
const DASHBOARD_BASE = 'https://comptox.epa.gov/dashboard/chemical/details';

interface ChemicalSearchHit {
  dtxsid?: string;
  preferredName?: string;
  casrn?: string;
}

interface HazardRecord {
  toxvalType?: string;
  toxvalSubtype?: string;
  riskAssessmentClass?: string;
  studyType?: string;
}

interface GhsRecord {
  hCode?: string;
  hStatement?: string;
  ghsCategory?: string;
}

export interface CompToxClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Per-request timeout in ms. Default 15000. */
  timeoutMs?: number;
}

export class CompToxClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: CompToxClientOptions) {
    if (!opts.apiKey) {
      throw new Error('CompToxClient requires an apiKey (set EPA_CCTE_API_KEY in .env.local).');
    }
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /**
   * Resolve a chemical to its DTXSID and pull GHS + hazard records.
   * Tries CAS first, falls back to name. Returns a `CompToxEntry` even on partial failure
   * so the cache always has *something* for the engine to read.
   */
  async lookup(args: { cas?: string; name?: string }): Promise<HazardEntry> {
    const fetchedAt = new Date().toISOString();
    const empty: HazardEntry = {
      source: 'comptox',
      external_id: null,
      preferred_name: null,
      ghs_codes: [],
      ghs_phrases: [],
      hazard_categories: [],
      source_url: null,
      fetched_at: fetchedAt,
    };

    let hit: ChemicalSearchHit | null = null;
    try {
      if (args.cas) hit = await this.searchByEqual(args.cas);
      if (!hit && args.name) hit = await this.searchByEqual(args.name);
    } catch (err) {
      return { ...empty, error: `chemical search failed: ${String(err)}` };
    }

    if (!hit?.dtxsid) {
      return { ...empty, error: 'no DTXSID match' };
    }

    const dtxsid = hit.dtxsid;
    const result: HazardEntry = {
      ...empty,
      external_id: dtxsid,
      preferred_name: hit.preferredName ?? null,
      source_url: `${DASHBOARD_BASE}/${dtxsid}`,
    };

    const [ghs, hazard] = await Promise.allSettled([
      this.getGhsByDtxsid(dtxsid),
      this.getHazardByDtxsid(dtxsid),
    ]);

    if (ghs.status === 'fulfilled') {
      const codes = new Set<string>();
      const phrases = new Set<string>();
      for (const g of ghs.value) {
        if (g.hCode) codes.add(g.hCode);
        if (g.hStatement) phrases.add(g.hStatement);
      }
      result.ghs_codes = [...codes].sort();
      result.ghs_phrases = [...phrases];
    } else {
      result.error = `ghs fetch failed: ${ghs.reason}`;
    }

    if (hazard.status === 'fulfilled') {
      const categories = new Set<string>();
      for (const h of hazard.value) {
        if (h.riskAssessmentClass) categories.add(h.riskAssessmentClass);
        if (h.toxvalType) categories.add(h.toxvalType);
      }
      result.hazard_categories = [...categories].sort();
    } else {
      const prev = result.error ? `${result.error}; ` : '';
      result.error = `${prev}hazard fetch failed: ${hazard.reason}`;
    }

    return result;
  }

  private async searchByEqual(query: string): Promise<ChemicalSearchHit | null> {
    const path = `/chemical/search/equal/${encodeURIComponent(query)}`;
    const data = await this.get<ChemicalSearchHit | ChemicalSearchHit[]>(path);
    if (Array.isArray(data)) return data[0] ?? null;
    return data ?? null;
  }

  private async getGhsByDtxsid(dtxsid: string): Promise<GhsRecord[]> {
    const path = `/ghs/search/by-dtxsid/${encodeURIComponent(dtxsid)}`;
    const data = await this.get<GhsRecord[] | null>(path);
    return data ?? [];
  }

  private async getHazardByDtxsid(dtxsid: string): Promise<HazardRecord[]> {
    const path = `/hazard/search/by-dtxsid/${encodeURIComponent(dtxsid)}`;
    const data = await this.get<HazardRecord[] | null>(path);
    return data ?? [];
  }

  private async get<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { 'x-api-key': this.apiKey, accept: 'application/json' },
        signal: ctrl.signal,
      });
      if (res.status === 404) return null as unknown as T;
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`CCTE ${res.status} on ${path}: ${body.slice(0, 200)}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(t);
    }
  }
}
