// Waste-stream separation rules.
//
// For every pair of tasks in the week, derive the set of waste groups each
// task produces (from each reagent's `epa_lookup_key`, which doubles as the
// waste-group identifier per the README). Pairwise check each (groupA, groupB)
// pair against waste_rules_map.csv. Emit a Separation for any rule whose
// `compatible` is `no` or `check` — those are the cases the lab needs to keep
// in mind.
//
// RCRA codes from /data/epa_cache.json are attached as supplementary citation,
// never as the basis of the rule.

import { loadEpaCache } from './data';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'csv-parse/sync';

import type { HydratedTask, Separation } from './types';

interface WasteRuleRow {
  waste_group_a: string;
  waste_group_b: string;
  compatible: 'yes' | 'no' | 'check';
  reason: string;
  // 'check' included so the row's severity column matches Separation.severity
  // even when a future CSV row uses 'check' as its severity (the runtime
  // assignment in buildSeparations already maps `compatible === 'check'` to
  // severity 'check', and the type now reflects that).
  severity: 'critical' | 'warning' | 'info' | 'check';
}

let _wasteRules: WasteRuleRow[] | null = null;
function loadWasteRules(): WasteRuleRow[] {
  if (_wasteRules) return _wasteRules;
  const path = resolve(process.cwd(), 'data/seed/waste_rules_map.csv');
  const raw = readFileSync(path, 'utf8');
  _wasteRules = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  }) as WasteRuleRow[];
  return _wasteRules;
}

interface PersonView {
  name: string;
  tasks: HydratedTask[];
}

/** Emit Separations for every (task_i, task_j, group_pair) that the rules
 *  table flags as incompatible or check-required. */
export function buildSeparations(people: PersonView[]): Separation[] {
  const tasks: HydratedTask[] = people.flatMap((p) => p.tasks);
  const wasteByTask = tasks.map((t) => ({
    task_id: t.task_id,
    waste_groups: deriveWasteGroups(t),
  }));

  const rules = loadWasteRules();
  const epa = loadEpaCache();
  const out: Separation[] = [];
  let counter = 0;

  for (let i = 0; i < wasteByTask.length; i++) {
    for (let j = i + 1; j < wasteByTask.length; j++) {
      const a = wasteByTask[i];
      const b = wasteByTask[j];

      // De-dup pair lookups so we don't fire two separations per (a,b)
      // when the same waste pair fires from both directions in the rule
      // table (the CSV is symmetric).
      const seenPairs = new Set<string>();

      for (const ga of a.waste_groups) {
        for (const gb of b.waste_groups) {
          if (ga === gb) continue;
          const pairKey = [ga, gb].sort().join('|');
          if (seenPairs.has(pairKey)) continue;

          const rule =
            rules.find(
              (r) => r.waste_group_a === ga && r.waste_group_b === gb
            ) ??
            rules.find(
              (r) => r.waste_group_a === gb && r.waste_group_b === ga
            );

          if (!rule) continue;
          if (rule.compatible === 'yes' && rule.severity === 'info') continue;
          // We surface 'no' (critical/warning) and 'check'. Skip benign yes/info.
          if (rule.compatible === 'yes') continue;

          seenPairs.add(pairKey);
          out.push({
            id: `sep_${counter++}_${slug(pairKey)}`,
            task_ids: [a.task_id, b.task_id],
            pair: [ga, gb],
            severity: rule.compatible === 'check' ? 'check' : rule.severity,
            reason: rule.reason,
            citations: [
              citationForGroup(ga, epa),
              citationForGroup(gb, epa),
            ].filter((c): c is NonNullable<typeof c> => c !== null),
          });
        }
      }
    }
  }

  return out;
}

function deriveWasteGroups(task: HydratedTask): string[] {
  const set = new Set<string>();
  for (const r of task.protocol.reagents) {
    // epa_lookup_key is also the waste-group identifier (per README).
    if (r.hazard?.epa_lookup_key) set.add(r.hazard.epa_lookup_key);
  }
  return [...set];
}

function citationForGroup(
  group: string,
  epa: ReturnType<typeof loadEpaCache>
) {
  const entry = epa[group];
  if (!entry) return null;
  const casEntries: {
    cas: string;
    name?: string;
    role?: string;
    dtxsid?: string;
  }[] = [];
  for (const item of entry.cas_numbers_involved ?? []) {
    if (typeof item === 'string') {
      if (item.trim()) casEntries.push({ cas: item.trim() });
    } else if (item && typeof item.cas === 'string' && item.cas.trim()) {
      casEntries.push({
        cas: item.cas.trim(),
        ...(item.name ? { name: item.name } : {}),
        ...(item.role ? { role: item.role } : {}),
        ...(item.dtxsid ? { dtxsid: item.dtxsid } : {}),
      });
    }
  }
  return {
    waste_group: group,
    rcra_code: entry.rcra_code ?? null,
    sources: entry.sources ?? [],
    cas_entries: casEntries,
    is_tri_listed: entry.tri_reportable === true,
  };
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** Test-only: reset the in-memory rules cache. */
export function __resetWasteRulesCache(): void {
  _wasteRules = null;
}
