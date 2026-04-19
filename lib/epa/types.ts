// Types shared across the EPA enrichment layer.
// Consumed both by scripts/build-epa-cache.ts (build time) and by lib/engine/* (runtime).

export interface ReagentMapRow {
  raw_term: string;
  normalized_name: string;
  generic_overlap_group: string;
  workflow_family: string;
  stage: string;
  shareable_prep: string;
  hazard_or_handling_flag: string;
  epa_lookup_key: string;
  /** Optional. The current data lead's reagent_term_map.csv does not ship CAS numbers,
   *  so the EPA build script falls back to name-based lookup when this is empty. */
  cas: string;
  protocol_examples: string;
}

/** GHS / hazard data for a single reagent. Filled in from EPA CompTox CCTE when an API
 *  key is available, otherwise from PubChem (NIH) which provides the same GHS codes
 *  via aggregated SDS data. The two sources are interchangeable from the engine's POV;
 *  the `source` field records which one populated this entry. */
export interface HazardEntry {
  source: 'comptox' | 'pubchem' | null;
  /** EPA DTXSID when source=comptox, PubChem CID (as string) when source=pubchem. */
  external_id: string | null;
  preferred_name: string | null;
  ghs_codes: string[];
  ghs_phrases: string[];
  hazard_categories: string[];
  source_url: string | null;
  fetched_at: string;
  /** Populated when the lookup partially or fully failed; the rest of the entry is best-effort. */
  error?: string;
}

/** @deprecated kept as alias during migration; new code should use HazardEntry. */
export type CompToxEntry = HazardEntry;

export interface TriEntry {
  is_listed: boolean;
  category: string | null;
  source_url: string;
  matched_on: 'cas' | 'name' | null;
}

export interface RcraEntry {
  codes: string[];
  list: 'F' | 'P' | 'U' | null;
  matched_on: 'cas' | 'name' | null;
  source_url: string;
}

export interface EpaCacheEntry {
  epa_lookup_key: string;
  lookups_used: { type: 'cas' | 'name'; value: string }[];
  hazard: HazardEntry | null;
  tri: TriEntry;
  rcra: RcraEntry;
  /** Engine-friendly summary derived from the three sources above. */
  summary: {
    has_any_hazard_signal: boolean;
    rcra_code_primary: string | null;
    is_tri_listed: boolean;
    ghs_code_count: number;
    hazard_source: 'comptox' | 'pubchem' | null;
  };
}

export interface EpaCache {
  version: 1;
  generated_at: string;
  entry_count: number;
  entries: Record<string, EpaCacheEntry>;
}
