BenchGreen demo lab catalog bundle

Purpose:
- equipment.csv: lab equipment catalog with capacity and configurable settings, per README.
- operators.csv: baseline operator windows for demo scheduling; these are intentionally broad.
- demo_ics/*.ics: actual uploaded demo calendars used as hard scheduling constraints.
- operator_ics_manifest.csv: binds operator IDs/names to the demo ICS files and horizon.
- demo_busy_windows_summary.csv: expanded summary of busy events during the 2026-04-20 to 2026-04-24 demo week.

Why operator windows are broad:
The README uses operator availability windows plus uploaded busy calendars. For these demos,
the ICS files contain the meaningful per-person constraints, so operators.csv is kept broad
(08:00-22:00 workday envelope) to avoid double-blocking valid lab slots.

How to use:
1. Load equipment.csv and operators.csv into the engine.
2. For each person, upload /demo_ics/<name>_schedule.ics or map via operator_ics_manifest.csv.
3. Use demo_busy_windows_summary.csv for quick visual QA/debugging of the scheduler.
