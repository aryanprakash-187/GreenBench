# BUGS_TODO

Issues caught during the ultrareview that we explicitly deferred. The five
high-impact bugs (impact-rollup over-claim, `nextMondayLocalIso` UTC drift,
`mergeScores` math, all-day ICS events, UTC-vs-local display) are already
fixed in `lib/engine/impact.ts`, `lib/engine/ics.ts`,
`lib/llm/matchProtocol.ts`, `components/OverviewPage.tsx`, and
`components/SchedulesPage.tsx`. Everything below is medium- or low-severity
follow-up.

## Medium

### 1. `lib/export/ics.ts` — dead code in `buildSharedCoordinationVevent`

In the `shared_reagent_prep` branch the `start` / `end` variables get an
initial value (the participant's task window) that is immediately
overwritten with the prep block (`[earliestStart − 50min, earliestStart −
30min]`). The dead assignment makes the timing intent hard to follow and
hides the actual window from anyone skimming the function. Remove the
overwritten lines and update the comment to state the prep block timing
explicitly.

### 2. `lib/export/ics.ts` — `foldLine` measures characters, not octets

RFC 5545 §3.1 mandates folding at **75 octets**, but the helper uses
`line.length` (UTF-16 code units). A SUMMARY containing a multi-byte
character (e.g. an em-dash, accented operator name, or future emoji) can
silently produce lines longer than 75 octets and break strict ICS parsers.
Use `Buffer.byteLength(line, 'utf8')` (or a manual byte counter) instead
and slice on byte boundaries.

### 3. `app/api/export/route.ts` — non-ASCII person name in response header

Line ~90 sets `'X-Labsync-Person': body.person_name`. HTTP headers must
be ISO-8859-1 (per RFC 7230); a name like `Müller` or `Naïma` raises
`TypeError: Invalid character in header content` in Node and Workers
runtimes. Either:

- omit the header (the body already carries the filename), or
- run it through `encodeURIComponent(body.person_name)` and document the
  encoding.

### 4. `lib/llm/client.ts` — `withTimeout` doesn't actually cancel the LLM call

`Promise.race` only races resolution; the underlying `model.generateContent`
keeps running and continues to bill against the Gemini quota even after the
caller has moved on. Pass an `AbortSignal` from an `AbortController` into
the SDK call (the Google GenAI SDK accepts `signal` on the request options)
and `controller.abort()` from the timeout branch.

### 5. `components/OverviewPage.tsx` — `SectionCard` uses `dangerouslySetInnerHTML`

`SectionCard` renders the title via `dangerouslySetInnerHTML`. Today every
caller passes a static literal so it's safe, but if the title ever becomes
LLM- or user-derived this is a stored-XSS sink. Replace with a
`children`-based title or a strict allowlist (e.g. only `<em>` / `<strong>`
through a tiny sanitizer). At minimum, add a `// eslint-disable-next-line
react/no-danger -- static literal only` comment to make the constraint
explicit.

### 6. `OverviewPage` / `SchedulesPage` — no auto-redirect on missing submission

Both pages render a `MissingState` if no plan is in `localStorage`/state,
but they don't `router.replace('/')`. A user landing on `/overview`
directly (bookmark, refresh after clearing storage) sees a dead-end card.
Add a `useEffect` that pushes back to `/` after a short delay (or
immediately) when `plan` is `null`.

### 7. `lib/engine/scheduler.ts` — `shared_equipment_run` rarely aligns

Now that the impact rollup gates on `c.aligned` (Bug 2 fix), the headline
"Equipment runs saved" number will almost always be 0 — the greedy
scheduler reserves the equipment for the first task it places and forces
every subsequent participant past the reservation, so two participants
never share a start. To make the saving real:

- when placing a task that participates in a `shared_equipment_run` and at
  least one peer is already scheduled, try the peer's start first and let
  the equipment reservation be **shared** rather than blocking, OR
- post-process: after the greedy pass, sweep the coordinations and re-run
  participants together if their windows allow.

This is the highest-value medium item — without it, the equipment savings
column on the dashboard will read zero.

### 8. `components/HomeForm.tsx` vs `app/api/plan/route.ts` — `synthTaskId` index off-by-one

The frontend stamps synthetic IDs as `__${index}` (0-based) while the
backend (`app/api/plan/route.ts`) stamps `__${idx + 1}` (1-based). The two
sides only collide if the backend ever has to synthesize an ID for a task
the frontend already named, but the inconsistency is a footgun. Pick one
convention (suggest 0-based to match array indices) and apply both sides.

### 9. `components/HomeForm.tsx` vs `app/api/plan/route.ts` — `parsePositiveInt` truncates decimals

The frontend's `parsePositiveInt` runs `parseInt("8.7", 10) → 8`, while the
backend's `Number(samplesRaw)` retains `8.7`. The match endpoint and the
plan endpoint then disagree about how many samples the lab is processing.
Either reject non-integers in `parsePositiveInt` (return the fallback) or
`Math.round` consistently on both sides.

## Low / nits

### 10. `.env.local` — `GEMINI_API_KEY` has a leading space, and the value was
shared in chat

The line reads `GEMINI_API_KEY= AIzaSyC...`. Most loaders trim the value,
but `process.env.GEMINI_API_KEY` could end up `" AIzaSy..."` depending on
the runtime. Rotate the key (it was shared in plain text) and remove the
leading space. The file is correctly gitignored.

### 11. `lib/engine/matcher.ts:isHazardousByGroup` — over-classifies `master_mix`

The heuristic flags any `overlap_group` containing `master_mix` as
hazardous. Most PCR master mixes are non-hazardous (Taq + dNTPs + buffer);
this inflates `hazardous_disposal_events_avoided`. Tighten the heuristic
to check the constituent reagents' EPA hazard flags rather than the group
name.

### 12. `lib/engine/scheduler.ts:pickAvailabilityWindow` — operator name match is case-insensitive but not diacritic-tolerant

`"José"` in `data/seed/operators.csv` will not match an input person named
`"Jose"` (or vice versa), and the scheduler silently falls back to the
default availability window. Normalize with
`s.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase()` on both
sides of the lookup.

### 13. `lib/llm/narrate.ts` — `wrapFallback` carries an unused `_unused` parameter

Cosmetic: the `_unused: ''` parameter only exists for symmetry with another
helper. Drop it.

### 14. `lib/engine/compatibility.ts` — `WasteRuleRow.severity` type mismatch

`Separation.severity` includes `'check'` at runtime, but the `WasteRuleRow`
CSV schema declares `severity: 'critical' | 'warning' | 'info'`. Either
add `'check'` to the schema union or map it to one of the three declared
values when building the row.

### 15. `components/HomeForm.tsx` — UI restricts each person to one protocol

`SubmissionPersonInput.protocols` is an array on the backend but the form
only collects one upload per person. Either render a multi-upload control
or narrow the backend type to a single protocol.

### 16. `lib/engine/matcher.ts:buildEquipmentCoordinations` — over-capacity equipment groups only suggest, never actually split into batched runs

Confirmed NOT a thermocycler/thermomixer mixup — they are deliberately two
different catalog rows in `data/seed/equipment.csv` (`thermocycler`,
capacity 96, used for PCR thermal cycling; `thermomixer`, capacity 24, a
`support_device` used for incubation/mixing steps like bead cleanup). The
engine already keys coordinations by `equipment_group`, so a PCR batching
card and a thermomixer batching card for the same two people are two
independent, correctly-separate recommendations — not a bug.

What IS a real gap: when `totalSamples > capacity` (e.g. 80 samples vs a
24-tube thermomixer), the code only emits an advisory string —
`` `${seg.length} tasks need ${group} but combined ${totalSamples} samples
exceed capacity ${capacity}; consider 2 batched runs instead of
${seg.length} separate.` `` — and computes `runs_saved` as
`Math.max(0, seg.length - Math.ceil(totalSamples / capacity))`, which is
usually 0 for a 2-person overflow (as in the Sohini/Vikas thermomixer case:
`2 - ceil(80/24) = 2 - 4 → 0`). It never actually proposes/schedules the "2
back-to-back runs" it tells the user to consider. Deferred for now; if
picked up later, the fix is to have `buildEquipmentCoordinations` actually
partition `seg` into `Math.ceil(totalSamples / capacity)` sub-batches (bin
by sample count, e.g. greedy or largest-remainder), emit one coordination
per sub-batch, and let `runs_saved` reflect the real reduction
(`seg.length − numSubBatches`) instead of clamping to 0.
