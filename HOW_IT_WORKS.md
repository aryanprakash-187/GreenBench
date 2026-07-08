# How LabSync works (for humans)

A plain-English walkthrough of how a PDF becomes a coordinated lab week, and the
one design idea that makes it reliable. No prior knowledge of the code needed.
For the terse AI-agent version see `AGENTS.md`; for deep technical detail see
`docs/`.

## What the product does, in one line

A labmate uploads a protocol PDF, we pull the useful facts out of it, the user
confirms them, and then plain (non-AI) code schedules everyone's week and finds
places where people can share reagent prep and equipment runs.

## The flow, step by step

1. **Upload.** Each labmate uploads a protocol PDF (and their calendar).
2. **Parse (the AI step).** We send the PDF to the LLM (Claude) with a prompt
   that says, in effect: "read this and tell me the reagents, equipment, sample
   counts, and (if it's PCR) the temperature program — and **don't invent
   anything**; if you can't find a value, say so instead of guessing." The LLM
   gives us back a structured object we call a **DraftProtocol**.
3. **Confirm (the human step).** We show the user every reagent the AI found and
   ask them to confirm/correct things — especially which "overlap group" each
   reagent belongs to. Nothing reaches the scheduling code until a human signs
   off. This is our safety net against the AI being wrong.
4. **Resolve.** Plain code turns the confirmed draft into the exact shape the
   engine needs (looks up hazard data, stability, equipment, etc.).
5. **Plan (the algorithm).** Pure, deterministic code (no AI) schedules each
   person's tasks around their calendar and finds coordination opportunities —
   "both of you need 70% ethanol Monday, prep it once" — and conflicts.
6. **Narrate + export.** The LLM writes the human-friendly sentences for the
   result cards, and we export an `.ics` calendar.

The important mental split: **the AI is only used to read messy PDFs and to
write prose. All the actual math and scheduling is done by plain code that
cannot hallucinate.**

## The one design idea that matters: the AI-to-algorithm contract

The plain code in step 5 does arithmetic on specific fields — it literally
computes `cycles × (denature + anneal + extend) time`. For that to work, the
AI's output has to have a field *named* `cycles` that *is* a number. So there's
a hard requirement: the AI's output must match a fixed shape (a "schema") that
the algorithm can read.

### How it worked before (the fragile way)

We passed the PDF + the "don't make things up" prompt and **hoped** the AI's
output happened to match the shape our algorithm needs. Then we checked it
against the schema afterwards. If *anything* didn't match — even one wrong field
name — we rejected the **entire** result and the upload failed.

Two problems with that:

- The AI never actually saw the exact shape we wanted (the prompt described it
  loosely; the strict rules lived in a separate file the AI doesn't read). So it
  guessed the shape and sometimes guessed differently — especially for the PCR
  temperature program, where we never spelled out the field names at all.
- The AI isn't perfectly repeatable, so the *same* PDF could pass once and fail
  the next time. One small mismatch threw away an otherwise-perfect parse.

### How it should work (the reliable way)

Instead of *hoping* the output matches and rejecting it when it doesn't, we
**hand the AI our exact desired schema and force it to fill that shape.** Modern
LLM APIs support this directly ("structured outputs" / constrained decoding):
the model is mechanically prevented from producing anything that breaks the
schema. It's a **guarantee, not a hope.**

A few clarifications on what "give it the schema" means:

- The **field names are fixed** by us (`cycles`, `annealing_temp_c`, …). The AI
  doesn't get to rename them.
- For certain **values**, we give the AI a fixed list to pick from (e.g. the
  allowed "overlap groups"). It must choose from the list — it can't invent a
  new category. This is what makes hallucination structurally hard.
- For the few things that genuinely vary protocol-to-protocol (like a PCR
  program, which can be 2-step, touchdown, multi-stage), we let the AI report
  what's there and then **plain code reshapes it** into what the engine needs.

### The layers, in priority order

1. **Structured outputs** — force the AI's output to match our schema at
   generation time. The big win; makes "wrong shape" failures nearly impossible.
2. **A reshaping/normalizing layer** — for the genuinely-variable parts, accept
   a looser version from the AI and have plain code fold it into the engine's
   exact shape. Embrace the variation instead of fighting it.
3. **Tiered strictness** — be strict on the fields the algorithm *must* have
   right; be forgiving on cosmetic labels (see the example below). A safety net
   for the things structured outputs can't check.
4. **Repair retry (optional, last resort)** — on the rare leftover failure, show
   the AI its own error and ask it to fix it, instead of giving up. Once 1–3 are
   in place this almost never fires.

> Status note: all four layers are implemented for the parser, plus prompt
> caching. Layer 1 (structured outputs) is **live and verified** against the
> Anthropic API on Sonnet 4.6 (grammar-constrained generation). It still
> **falls back automatically** to prompt + zod on any endpoint that doesn't
> support the `output_config` parameter, so it's safe regardless of
> provider/SDK version. zod remains the authoritative check in every path.

## Why not just say "don't make anything up" and skip the schema?

Because "don't make things up" only fixes *hallucination* (inventing values).
It does nothing for *structure* — the algorithm still needs the answer in a
specific shape it can read. Those are two separate problems; we need to solve
both.

## Extending to new protocols

The product is for labs in general, not just our three starter families (DNA
extraction, PCR, bead cleanup). For a protocol that's fundamentally different in
nature, the reagent/equipment/sample backbone still works, but you'll do a
bounded redesign: add that protocol's structured core to the schema, add its
vocabulary entries, and teach the engine its timing/coordination rules. This is
expected — the pipeline is custom-fit per lab. See
`ChangesToBeMadeForPilot.md` → "Extending to new protocol families."
