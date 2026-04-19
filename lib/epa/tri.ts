// TRI (Toxics Release Inventory) lookup against static CSV(s).
//
// The full TRI Chemical List is a few hundred KB and is published by EPA at:
//   https://www.epa.gov/toxics-release-inventory-tri-program/tri-listed-chemicals
// Download the latest reporting-year XLSX, convert to CSV (one CSV per sheet is fine),
// and drop the file(s) at data/tri_chemicals/ (one or more .csv files). The loader
// merges all CSVs in that folder.
//
// We don't hit any TRI API at runtime — listed-or-not is a static fact.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'csv-parse/sync';

import type { TriEntry } from './types.js';

const TRI_SOURCE_URL =
  'https://www.epa.gov/toxics-release-inventory-tri-program/tri-listed-chemicals';

interface TriRow {
  cas: string;
  name: string;
  category: string;
}

export class TriClient {
  private rowsByCas: Map<string, TriRow> = new Map();
  private rowsByName: Map<string, TriRow> = new Map();
  private loaded = false;
  private missing = false;
  /** Number of distinct chemical rows loaded across all CSVs. */
  private rowCount = 0;

  /** `path` may be a single .csv file OR a directory containing one or more .csv files. */
  constructor(private readonly path: string) {}

  load(): void {
    if (this.loaded) return;
    this.loaded = true;

    if (!existsSync(this.path)) {
      this.missing = true;
      return;
    }

    const stat = statSync(this.path);
    const csvFiles: string[] = stat.isDirectory()
      ? readdirSync(this.path)
          .filter((f) => f.toLowerCase().endsWith('.csv'))
          .map((f) => join(this.path, f))
      : [this.path];

    if (!csvFiles.length) {
      this.missing = true;
      return;
    }

    for (const file of csvFiles) {
      this.loadFile(file);
    }
  }

  private loadFile(file: string): void {
    const text = readFileSync(file, 'utf8');
    const records = parse(text, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    }) as Record<string, string>[];

    for (const rec of records) {
      const cas = (rec['CASRN'] ?? rec['CAS'] ?? rec['CAS Number'] ?? '').replace(/^0+/, '').trim();
      const name = (rec['Chemical Name'] ?? rec['Name'] ?? rec['CHEMICAL'] ?? '').trim();
      const category =
        (rec['Category Description'] ?? rec['Category'] ?? rec['Chemical Category'] ?? '').trim() ||
        'individual_chemical';

      if (!cas && !name) continue;
      const row: TriRow = { cas, name, category };
      if (cas) this.rowsByCas.set(this.normalizeCas(cas), row);
      if (name) this.rowsByName.set(name.toLowerCase(), row);
      this.rowCount += 1;
    }
  }

  /** Total chemical rows ingested (post-load). Useful for build-script output. */
  totalRows(): number {
    this.load();
    return this.rowCount;
  }

  isFileMissing(): boolean {
    this.load();
    return this.missing;
  }

  lookup(args: { cas?: string; name?: string }): TriEntry {
    this.load();

    if (this.missing) {
      return {
        is_listed: false,
        category: null,
        source_url: TRI_SOURCE_URL,
        matched_on: null,
      };
    }

    if (args.cas) {
      const hit = this.rowsByCas.get(this.normalizeCas(args.cas));
      if (hit) {
        return {
          is_listed: true,
          category: hit.category,
          source_url: TRI_SOURCE_URL,
          matched_on: 'cas',
        };
      }
    }
    if (args.name) {
      const hit = this.rowsByName.get(args.name.toLowerCase());
      if (hit) {
        return {
          is_listed: true,
          category: hit.category,
          source_url: TRI_SOURCE_URL,
          matched_on: 'name',
        };
      }
    }

    return {
      is_listed: false,
      category: null,
      source_url: TRI_SOURCE_URL,
      matched_on: null,
    };
  }

  private normalizeCas(cas: string): string {
    return cas.replace(/[^0-9-]/g, '');
  }
}
