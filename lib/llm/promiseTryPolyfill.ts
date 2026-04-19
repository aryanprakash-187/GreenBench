// Polyfill for Promise.try (ES2025 / Node 22.10+).
//
// Why this file exists: `unpdf`'s bundled pdf.js calls `Promise.try` in an
// internal worker callback. On Node < 22.10 that throws a TypeError inside
// a callback that isn't on the awaited chain — so it surfaces as an
// unhandled rejection, the outer `await extractText(doc)` hangs, and
// `/api/match` falls through to the multi-MB-PDF-to-Gemini path that
// takes 10–60s per protocol. This polyfill restores the fast tier on
// older Node without forcing everyone to upgrade their runtime.
//
// Spec: Promise.try(fn) runs fn synchronously, wraps thrown errors as a
// rejected promise, and threads the return value (or thenable) through.
// The shim below matches that behavior; on Node ≥ 22.10 it's a no-op.

if (typeof (Promise as unknown as { try?: unknown }).try !== 'function') {
  (Promise as unknown as {
    try: <T>(fn: () => T | PromiseLike<T>) => Promise<T>;
  }).try = function <T>(fn: () => T | PromiseLike<T>): Promise<T> {
    return new Promise<T>((resolve) => resolve(fn()));
  };
}

export {};
