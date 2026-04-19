// RCRA F/P/U-list lookup against the curated JSON in data/static/rcra_codes.json.
//
// Source: 40 CFR § 261 Subpart D
//   https://www.ecfr.gov/current/title-40/chapter-I/subchapter-I/part-261/subpart-D
//
// We keep this static rather than scraping at build time because the regulatory text
// effectively never changes within a hackathon cycle, and the file is small enough to
// curate by hand for the reagents we actually care about.

import { readFileSync } from 'node:fs';

import type { RcraEntry } from './types.js';

const RCRA_SOURCE_URL =
  'https://www.ecfr.gov/current/title-40/chapter-I/subchapter-I/part-261/subpart-D';

interface RcraStatic {
  by_cas: Record<string, { codes: string[]; name: string; list: 'F' | 'P' | 'U' }>;
  by_name: Record<string, string>;
}

export class RcraClient {
  private data: RcraStatic;

  constructor(jsonPath: string) {
    const raw = JSON.parse(readFileSync(jsonPath, 'utf8'));
    this.data = { by_cas: raw.by_cas ?? {}, by_name: raw.by_name ?? {} };
  }

  lookup(args: { cas?: string; name?: string }): RcraEntry {
    if (args.cas) {
      const hit = this.data.by_cas[args.cas];
      if (hit) {
        return {
          codes: hit.codes,
          list: hit.list,
          matched_on: 'cas',
          source_url: RCRA_SOURCE_URL,
        };
      }
    }
    if (args.name) {
      const cas = this.data.by_name[args.name.toLowerCase()];
      if (cas) {
        const hit = this.data.by_cas[cas];
        if (hit) {
          return {
            codes: hit.codes,
            list: hit.list,
            matched_on: 'name',
            source_url: RCRA_SOURCE_URL,
          };
        }
      }
    }
    return {
      codes: [],
      list: null,
      matched_on: null,
      source_url: RCRA_SOURCE_URL,
    };
  }
}
