// TEMPORARY DEBUG ENDPOINT — cleanup9 verification.
//
// GET /api/debug/summary            → summary over all 9 seeds
// GET /api/debug/summary?protocols=A|B|C   → summary over the given subset
//                                            (pipe-separated because names contain commas)
//
// Returns:
//   - source_files: paths read from disk (so you can confirm the new CSVs are live)
//   - protocols_loaded: exact protocol_name strings the engine sees
//   - overlap_groups_matched: generic_overlap_groups with >=2 contributing
//                             protocols (grouped by workflow family)
//   - waste_groups_present: union of epa_lookup_key across the selected set
//   - waste_rule_conflicts_triggered: rows from waste_rules_map.csv whose
//                                     (a,b) both appear and compatible !== 'yes'
//   - equipment_models_shared: preferred_model_ids that appear across >=2 of the
//                              selected protocols, with which protocols share it
//
// Safe to remove once the cleanup9 verification is done — no other code imports
// this route.

import { NextRequest, NextResponse } from 'next/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'csv-parse/sync';

import {
  loadProtocols,
  loadProtocolReagents,
  loadReagentTermMap,
  loadOverlapRules,
  loadProtocolEquipmentRequirements,
} from '@/lib/engine/data';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface WasteRuleRow {
  waste_group_a: string;
  waste_group_b: string;
  compatible: 'yes' | 'no' | 'check';
  reason: string;
  severity: 'critical' | 'warning' | 'info' | 'check';
}

function loadWasteRulesFresh(): WasteRuleRow[] {
  // Intentionally NOT reusing the memoized copy in lib/engine/compatibility.ts —
  // for a debug endpoint we want the bytes on disk.
  const raw = readFileSync(
    resolve(process.cwd(), 'data/seed/waste_rules_map.csv'),
    'utf8'
  );
  return parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  }) as WasteRuleRow[];
}

export function GET(req: NextRequest) {
  const url = new URL(req.url);
  const selectedParam = url.searchParams.get('protocols');

  const allProtocols = loadProtocols();
  const allNames = allProtocols.map((p) => p.protocol_name);

  // Subset selection: pipe-separated because several protocol names contain commas.
  const requestedNames = selectedParam
    ? selectedParam.split('|').map((s) => s.trim()).filter(Boolean)
    : allNames.slice();

  const unknown = requestedNames.filter((n) => !allNames.includes(n));
  const known = requestedNames.filter((n) => allNames.includes(n));

  // ---- Overlap groups (from protocol_reagents.csv × reagent_term_map.csv) ----

  const reagents = loadProtocolReagents();
  const termMap = loadReagentTermMap();
  const termByRaw = new Map(termMap.map((r) => [r.raw_term, r]));

  // family -> group -> Set of protocol_name contributors
  const overlapByFamilyGroup = new Map<
    string,
    Map<string, Set<string>>
  >();

  for (const row of reagents) {
    if (!known.includes(row.protocol_name)) continue;
    const term = termByRaw.get(row.reagent_raw_term);
    if (!term) continue;
    if (String(term.shareable_prep).toLowerCase() !== 'yes') continue;
    const group = term.generic_overlap_group;
    if (!group) continue;
    const family =
      allProtocols.find((p) => p.protocol_name === row.protocol_name)?.family ??
      '?';

    let byGroup = overlapByFamilyGroup.get(family);
    if (!byGroup) {
      byGroup = new Map();
      overlapByFamilyGroup.set(family, byGroup);
    }
    let contribs = byGroup.get(group);
    if (!contribs) {
      contribs = new Set();
      byGroup.set(group, contribs);
    }
    contribs.add(row.protocol_name);
  }

  const overlap_groups_matched: Array<{
    family: string;
    overlap_group: string;
    protocols: string[];
  }> = [];
  for (const [family, byGroup] of overlapByFamilyGroup) {
    for (const [group, protos] of byGroup) {
      if (protos.size < 2) continue;
      overlap_groups_matched.push({
        family,
        overlap_group: group,
        protocols: [...protos].sort(),
      });
    }
  }
  overlap_groups_matched.sort((a, b) =>
    (a.family + a.overlap_group).localeCompare(b.family + b.overlap_group)
  );

  // ---- Waste groups present (epa_lookup_key from reagent_term_map) ----

  const wasteGroups = new Set<string>();
  for (const row of reagents) {
    if (!known.includes(row.protocol_name)) continue;
    const term = termByRaw.get(row.reagent_raw_term);
    if (!term) continue;
    if (term.epa_lookup_key) wasteGroups.add(term.epa_lookup_key);
  }
  const waste_groups_present = [...wasteGroups].sort();

  // ---- Waste rule conflicts ----

  const wasteRules = loadWasteRulesFresh();
  const seenPairs = new Set<string>();
  const waste_rule_conflicts_triggered: Array<{
    pair: [string, string];
    compatible: string;
    severity: string;
    reason: string;
  }> = [];

  for (const rule of wasteRules) {
    if (!wasteGroups.has(rule.waste_group_a)) continue;
    if (!wasteGroups.has(rule.waste_group_b)) continue;
    if (rule.compatible === 'yes') continue;
    const key = [rule.waste_group_a, rule.waste_group_b].sort().join('|');
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    waste_rule_conflicts_triggered.push({
      pair: [rule.waste_group_a, rule.waste_group_b],
      compatible: rule.compatible,
      severity: rule.severity,
      reason: rule.reason,
    });
  }

  // ---- Equipment models shared across selected protocols ----

  const equipRows = loadProtocolEquipmentRequirements();
  const modelToProtos = new Map<
    string,
    { equipment_type: string; protocols: Set<string> }
  >();
  for (const row of equipRows) {
    if (!known.includes(row.protocol_name)) continue;
    if (!row.preferred_model_id) continue;
    const entry =
      modelToProtos.get(row.preferred_model_id) ?? {
        equipment_type: row.equipment_type,
        protocols: new Set<string>(),
      };
    entry.protocols.add(row.protocol_name);
    modelToProtos.set(row.preferred_model_id, entry);
  }
  const equipment_models_shared: Array<{
    preferred_model_id: string;
    equipment_type: string;
    protocols: string[];
  }> = [];
  for (const [model, { equipment_type, protocols }] of modelToProtos) {
    if (protocols.size < 2) continue;
    equipment_models_shared.push({
      preferred_model_id: model,
      equipment_type,
      protocols: [...protocols].sort(),
    });
  }
  equipment_models_shared.sort((a, b) =>
    a.preferred_model_id.localeCompare(b.preferred_model_id)
  );

  // ---- Touch unused imports so tree-shake doesn't strip them in build ----
  // (loadOverlapRules isn't consumed here but confirming it parses on demand
  // is useful; keep the reference as a health check.)
  const overlapRuleCount = loadOverlapRules().length;

  return NextResponse.json({
    source_files: {
      seed_dir: 'data/seed',
      protocols_selected: 'data/seed/protocols_selected.csv',
      protocol_reagents: 'data/seed/protocol_reagents.csv',
      reagent_term_map: 'data/seed/reagent_term_map.csv',
      waste_rules_map: 'data/seed/waste_rules_map.csv',
      overlap_rules: 'data/seed/overlap_rules.csv',
      protocol_equipment_requirements:
        'data/seed/protocol_equipment_requirements.csv',
      protocol_pdf_mapping: 'data/seed/protocol_pdf_mapping.csv',
    },
    counts: {
      protocols_total: allNames.length,
      protocols_selected: known.length,
      protocol_reagent_rows: reagents.length,
      reagent_term_map_rows: termMap.length,
      overlap_rule_rows: overlapRuleCount,
      waste_rule_rows: wasteRules.length,
      equipment_req_rows: equipRows.length,
    },
    protocols_loaded: allNames,
    protocols_selected_for_summary: known,
    unknown_protocols: unknown,
    overlap_groups_matched,
    waste_groups_present,
    waste_rule_conflicts_triggered,
    equipment_models_shared,
  });
}
