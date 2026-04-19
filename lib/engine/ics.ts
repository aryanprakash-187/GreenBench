// Tiny ICS parser, scoped to what the engine needs.
//
// Handles single VEVENTs with DTSTART/DTEND/SUMMARY (and DTSTART;VALUE=DATE
// for all-day events). Does NOT expand RRULE — for the demo we treat each
// uploaded calendar as a flat list of one-off blocks.
//
// Returns intervals clipped to the planning week [week_start, week_start + 7d).
//
// Why hand-rolled instead of node-ical: zero new deps, ~80 lines, and the demo
// only needs to honor user-uploaded busy blocks, not generate calendars.
// (We do still pull in the `ics` package for export later — that's generation,
// a separate problem.)

import type { BusyInterval } from './types';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

interface RawEvent {
  start: Date | null;
  end: Date | null;
  summary: string;
  /** True iff DTSTART was a date-only value (VALUE=DATE or YYYYMMDD). RFC
   *  5545 says a date-only DTSTART with no DTEND covers the whole day. */
  startIsDateOnly: boolean;
}

/** Parse an ICS string and return BusyIntervals that overlap the week.
 *  - `weekStartIso` is the inclusive week start (00:00 of Monday).
 *  - Events outside the week are dropped.
 *  - Events that straddle the week boundary are clipped to the boundary. */
export function parseIcsToBusy(
  icsText: string,
  weekStartIso: string
): BusyInterval[] {
  const weekStart = new Date(weekStartIso);
  if (Number.isNaN(weekStart.getTime())) {
    throw new Error(`Invalid week_start_iso: ${weekStartIso}`);
  }
  const weekEnd = new Date(weekStart.getTime() + WEEK_MS);

  // RFC 5545 unfolds long lines: a line starting with a space/tab continues
  // the previous line. Do that first.
  const unfolded = icsText.replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);

  const events: RawEvent[] = [];
  let current: RawEvent | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line === 'BEGIN:VEVENT') {
      current = { start: null, end: null, summary: '', startIsDateOnly: false };
      continue;
    }
    if (line === 'END:VEVENT') {
      if (current) events.push(current);
      current = null;
      continue;
    }
    if (!current) continue;

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const head = line.slice(0, colonIdx);
    const value = line.slice(colonIdx + 1);
    const propName = head.split(';')[0].toUpperCase();

    if (propName === 'DTSTART') {
      current.start = parseIcsDate(head, value);
      current.startIsDateOnly = isDateOnlyIcsValue(head, value);
    } else if (propName === 'DTEND') {
      current.end = parseIcsDate(head, value);
    } else if (propName === 'SUMMARY') {
      current.summary = unescapeIcsText(value);
    }
  }

  const intervals: BusyInterval[] = [];
  const DAY_MS = 24 * 60 * 60 * 1000;
  for (const ev of events) {
    if (!ev.start) continue;
    // ICS allows VEVENTs without DTEND. RFC 5545 §3.6.1 says a date-only
    // DTSTART with no DTEND covers the entire day (one-day all-day event);
    // a datetime DTSTART with no DTEND is treated as zero duration. We
    // bump the latter to a 1h default so a calendar entry someone forgot
    // to give an end time still blocks something meaningful.
    const end =
      ev.end ??
      (ev.startIsDateOnly
        ? new Date(ev.start.getTime() + DAY_MS)
        : new Date(ev.start.getTime() + 60 * 60 * 1000));

    // Clip to the planning week.
    const clipStart = ev.start < weekStart ? weekStart : ev.start;
    const clipEnd = end > weekEnd ? weekEnd : end;
    if (clipStart >= clipEnd) continue;

    intervals.push({
      start_iso: clipStart.toISOString(),
      end_iso: clipEnd.toISOString(),
      summary: ev.summary,
    });
  }

  // Sort + merge overlapping busy blocks so the scheduler doesn't see
  // duplicates from messy calendars.
  intervals.sort((a, b) => a.start_iso.localeCompare(b.start_iso));
  return mergeOverlapping(intervals);
}

function mergeOverlapping(intervals: BusyInterval[]): BusyInterval[] {
  if (intervals.length === 0) return [];
  const out: BusyInterval[] = [intervals[0]];
  for (let i = 1; i < intervals.length; i++) {
    const prev = out[out.length - 1];
    const cur = intervals[i];
    if (cur.start_iso <= prev.end_iso) {
      // Overlap → extend the previous interval. Keep the earlier summary or
      // join them so the scheduler can still surface why a slot is busy.
      const newEnd = cur.end_iso > prev.end_iso ? cur.end_iso : prev.end_iso;
      out[out.length - 1] = {
        start_iso: prev.start_iso,
        end_iso: newEnd,
        summary: prev.summary && cur.summary && prev.summary !== cur.summary
          ? `${prev.summary} + ${cur.summary}`
          : prev.summary || cur.summary,
      };
    } else {
      out.push(cur);
    }
  }
  return out;
}

/** Parse an ICS date/datetime value. Supports:
 *   20260420T140000Z          (UTC)
 *   20260420T140000           (floating local — interpreted as UTC for demo)
 *   20260420                  (date-only; midnight UTC of that day — the
 *                              caller is responsible for extending the end
 *                              bound to cover the full day if no DTEND was
 *                              supplied)
 *  When `head` carries `;VALUE=DATE` we always treat the value as date-only.
 *  When `head` carries `;TZID=...` we ignore the TZ (demo simplification —
 *  uploaded calendars from the team are expected to be UTC or floating). */
function isDateOnlyIcsValue(head: string, value: string): boolean {
  return (
    (head.toUpperCase().includes('VALUE=DATE') && !value.includes('T')) ||
    /^\d{8}$/.test(value)
  );
}

function parseIcsDate(head: string, value: string): Date | null {
  if (isDateOnlyIcsValue(head, value)) {
    // YYYYMMDD → midnight UTC of that day.
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
    if (!m) return null;
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 0, 0, 0));
  }

  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (z === 'Z') {
    return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  }
  // Floating time: treat as UTC for the demo. (Switching to per-person TZs
  // later would mean carrying a TZID through the whole engine — out of scope.)
  return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
}

function unescapeIcsText(s: string): string {
  return s
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

/** Compute the ISO timestamp for the next Monday at 00:00 UTC. The whole
 *  engine treats `week_start_iso` as a UTC anchor (the scheduler uses
 *  `getUTCDay()` to walk the days of the week), so we keep this calculation
 *  in UTC end-to-end. Mixing local and UTC arithmetic here would make a
 *  server in CET/JST etc. report "Monday" but anchor on Sunday UTC, then
 *  the scheduler would map operator availability to the wrong day column.
 *
 *  If today (UTC) is Monday, returns today at 00:00 UTC. */
export function nextMondayLocalIso(now: Date = new Date()): string {
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const dayOfWeek = d.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const daysUntil = (1 - dayOfWeek + 7) % 7;
  d.setUTCDate(d.getUTCDate() + daysUntil);
  return d.toISOString();
}
