// Server-side loaders for the seed CSVs and JSON caches.
//
// All loaders are memoized for the lifetime of the Node process — the seed data is
// read-only at runtime, so re-parsing on every request is wasteful. In dev (Next.js
// hot reload) the cache is invalidated when the module is reloaded.
//
// IMPORTANT: this module is server-only. It calls fs and resolves paths from
// process.cwd(); do not import it from client components.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'csv-parse/sync';

import type {
  EquipmentRow,
  EquipmentTermMapRow,
  OverlapRuleRow,
  ProtocolEquipmentRequirementRow,
  ProtocolReagentRow,
  ProtocolSelectedRow,
  ProtocolThermalProfileRow,
  ReagentStabilityRow,
  ReagentTermMapRow,
} from './types';

const SEED_DIR = resolve(process.cwd(), 'data/seed');
const EPA_CACHE_PATH = resolve(process.cwd(), 'data/epa_cache.json');
const IMPACT_PATH = resolve(process.cwd(), 'data/impact_coefficients.json');

function readCsv<T>(filename: string): T[] {
  const path = resolve(SEED_DIR, filename);
  const raw = readFileSync(path, 'utf8');
  return parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_quotes: true,
    bom: true,
  }) as T[];
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

// ----- Memoized loaders -----

let _protocols: ProtocolSelectedRow[] | null = null;
export function loadProtocols(): ProtocolSelectedRow[] {
  if (!_protocols) _protocols = readCsv<ProtocolSelectedRow>('protocols_selected.csv');
  return _protocols;
}

let _reagentMap: ReagentTermMapRow[] | null = null;
export function loadReagentTermMap(): ReagentTermMapRow[] {
  if (!_reagentMap) _reagentMap = readCsv<ReagentTermMapRow>('reagent_term_map.csv');
  return _reagentMap;
}

let _protocolReagents: ProtocolReagentRow[] | null = null;
export function loadProtocolReagents(): ProtocolReagentRow[] {
  if (!_protocolReagents) {
    _protocolReagents = readCsv<ProtocolReagentRow>('protocol_reagents.csv');
  }
  return _protocolReagents;
}

let _thermalProfiles: ProtocolThermalProfileRow[] | null = null;
export function loadThermalProfiles(): ProtocolThermalProfileRow[] {
  if (!_thermalProfiles) {
    _thermalProfiles = readCsv<ProtocolThermalProfileRow>('protocol_thermal_profiles.csv');
  }
  return _thermalProfiles;
}

let _stability: ReagentStabilityRow[] | null = null;
export function loadReagentStability(): ReagentStabilityRow[] {
  if (!_stability) _stability = readCsv<ReagentStabilityRow>('reagent_stability.csv');
  return _stability;
}

let _overlapRules: OverlapRuleRow[] | null = null;
export function loadOverlapRules(): OverlapRuleRow[] {
  if (!_overlapRules) _overlapRules = readCsv<OverlapRuleRow>('overlap_rules.csv');
  return _overlapRules;
}

let _equipment: EquipmentRow[] | null = null;
export function loadEquipment(): EquipmentRow[] {
  if (!_equipment) _equipment = readCsv<EquipmentRow>('equipment.csv');
  return _equipment;
}

export interface OperatorRow {
  id: string;
  name: string;
  availability_mon: string;
  availability_tue: string;
  availability_wed: string;
  availability_thu: string;
  availability_fri: string;
  availability_sat?: string;
  availability_sun?: string;
  notes: string;
}

let _operators: OperatorRow[] | null = null;
export function loadOperators(): OperatorRow[] {
  if (!_operators) _operators = readCsv<OperatorRow>('operators.csv');
  return _operators;
}

let _equipmentTermMap: EquipmentTermMapRow[] | null = null;
export function loadEquipmentTermMap(): EquipmentTermMapRow[] {
  if (!_equipmentTermMap) {
    _equipmentTermMap = readCsv<EquipmentTermMapRow>('equipment_term_map.csv');
  }
  return _equipmentTermMap;
}

let _protocolEquipmentReqs: ProtocolEquipmentRequirementRow[] | null = null;
export function loadProtocolEquipmentRequirements(): ProtocolEquipmentRequirementRow[] {
  if (!_protocolEquipmentReqs) {
    _protocolEquipmentReqs = readCsv<ProtocolEquipmentRequirementRow>(
      'protocol_equipment_requirements.csv'
    );
  }
  return _protocolEquipmentReqs;
}

// ----- EPA + impact JSON -----

export interface EpaCasEntry {
  cas: string;
  name?: string;
  role?: string;
}

interface EpaCacheLegacyEntry {
  /** Either an array of bare CAS strings (old format) or {cas,name,role} objects (new). */
  cas_numbers_involved?: Array<string | EpaCasEntry>;
  epa_classification?: string;
  tri_reportable?: boolean | null;
  comptox_hazard_flags?: string[];
  rcra_code?: string | null;
  incompatibilities?: string[];
  classification_by_analogy?: boolean;
  sources?: string[];
  pulled_on?: string;
}

/** The shipped epa_cache.json is currently keyed directly by epa_lookup_key (the
 *  bucket-by-analogy format used in the seed data). The richer per-CAS format from
 *  scripts/build-epa-cache.ts (EpaCache with .entries) is the future shape; for now
 *  we accept either by sniffing the structure. */
export type EpaCacheShape = Record<string, EpaCacheLegacyEntry>;

let _epaCache: EpaCacheShape | null = null;
export function loadEpaCache(): EpaCacheShape {
  if (_epaCache) return _epaCache;
  const raw = readJson<unknown>(EPA_CACHE_PATH);
  // Sniff: { version, entries } -> use .entries; otherwise treat as flat key->entry map.
  if (
    raw &&
    typeof raw === 'object' &&
    'entries' in (raw as Record<string, unknown>)
  ) {
    _epaCache = (raw as { entries: EpaCacheShape }).entries;
  } else {
    _epaCache = raw as EpaCacheShape;
  }
  return _epaCache;
}

interface ImpactRangeKg {
  low: number;
  mid: number;
  high: number;
}

interface ImpactCoefficientsShape {
  reagents: Record<
    string,
    {
      co2e_kg_per_liter?: ImpactRangeKg;
      hazardous_disposal_cost_usd_per_liter?: ImpactRangeKg;
      source_type?: string;
    }
  >;
  consumables?: Record<string, unknown>;
  notes?: string;
}

let _impact: ImpactCoefficientsShape | null = null;
export function loadImpactCoefficients(): ImpactCoefficientsShape {
  if (!_impact) _impact = readJson<ImpactCoefficientsShape>(IMPACT_PATH);
  return _impact;
}

// ----- Convenience: seed data version (for provenance) -----

export function seedDataVersion(): string {
  // Hash-free version: just the count of protocols + reagents. Stable enough for the
  // demo's "show provenance" expandable; swap in a content hash later if needed.
  const p = loadProtocols().length;
  const r = loadReagentTermMap().length;
  return `seed-v1-${p}p-${r}r`;
}

/** Reset all in-memory caches. Useful in tests; not used in production. */
export function __resetCaches(): void {
  _protocols = null;
  _reagentMap = null;
  _protocolReagents = null;
  _thermalProfiles = null;
  _stability = null;
  _overlapRules = null;
  _equipment = null;
  _equipmentTermMap = null;
  _protocolEquipmentReqs = null;
  _operators = null;
  _epaCache = null;
  _impact = null;
}
