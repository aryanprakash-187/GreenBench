# BenchGreen demo script (90 seconds)

Last week I ran DNA extraction on Monday and my labmate ran PCR on Tuesday and cleanup on Wednesday.
We prepped wash solvent separately, used shared equipment in underfilled runs, and handled waste in disconnected steps.

BenchGreen fixes that.

On the first page, we assign each person a protocol and sample count, then upload their busy calendar.
Behind the scenes, the app normalizes the protocols into reagents, consumables, equipment, timings, and waste streams.

On the coordination page, the top recommendation shows a concrete save:
for example, preparing 70% ethanol once for the cleanup workflows instead of making it multiple times.
It also flags when we should *not* combine things — like chaotropic extraction waste with bleach-based cleaning streams.

Because the engine is deterministic, every merge and every separation is based on a table lookup, not on the language model guessing.
The LLM is only used for parsing messy protocol text and writing the explanation in plain English.

At the top, we show weekly impact:
reagent volume saved, plastic avoided, hazardous handling events avoided, and a CO2e range.

At the bottom, we turn that coordinated workflow into scheduled lab blocks and export them to calendar files.

So the value is simple:
protocols stay sacred, but the work gets coordinated.
