// Read/write helpers for /data/epa_cache.json — the artifact the deterministic engine
// consumes at runtime. The build script writes this; the engine and UI only read it.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { EpaCache, EpaCacheEntry } from './types.js';

export function emptyCache(): EpaCache {
  return {
    version: 1,
    generated_at: new Date().toISOString(),
    entry_count: 0,
    entries: {},
  };
}

export function loadCache(path: string): EpaCache {
  if (!existsSync(path)) return emptyCache();
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as EpaCache;
    if (data?.version === 1 && data?.entries) return data;
  } catch {
    // fall through to empty
  }
  return emptyCache();
}

export function saveCache(path: string, entries: Record<string, EpaCacheEntry>): EpaCache {
  const cache: EpaCache = {
    version: 1,
    generated_at: new Date().toISOString(),
    entry_count: Object.keys(entries).length,
    entries,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cache, null, 2) + '\n', 'utf8');
  return cache;
}
