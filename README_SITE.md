# Green Bench

A professional web app that merges lab schedules to increase sustainability.

Front-end for **BenchGreen Copilot** (see the full product spec above this line in the main README). The website intakes a planner's name, up to three lab protocols, and three `.ics` calendar files. On submit it navigates to a three-tab output — **Plan → Coordinate → Export** — matching the UI flow described in the product spec.

## Stack

- **Next.js 14** (App Router) + **TypeScript**
- **Tailwind CSS** with a custom earth-toned palette (moss green, ocean blue, sand/clay earth neutrals)
- **Fraunces** (display) + **Inter** (body) via Google Fonts
- No backend services; submissions are kept in the browser (`sessionStorage`) so the page is fully stateless per the spec.

## Run locally

```bash
npm install
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000).

## Pages

- `/` — Landing hero (`Green Bench` title, *schedule for sustainability* subtitle, welcome copy) with snap-scroll into the home form (name, 3× Lab Protocol uploads, 3× Schedule `.ics` uploads, Submit).
- `/results` — Tabbed output: **Plan** (parsed inputs + week outline), **Coordinate** (impact summary, recommendation cards with vendor-term normalization and EPA citations, separation warnings), **Export** (per-operator `.ics` downloads with calendar preview).

## Structure

```
app/
  layout.tsx
  globals.css
  page.tsx                 # landing + home (continuous scroll)
  results/
    page.tsx
    tabs/
      PlanTab.tsx
      CoordinateTab.tsx
      ExportTab.tsx
components/
  Hero.tsx
  HomeForm.tsx
  ResultsView.tsx
tailwind.config.ts
```

The engine, EPA cache, and LLM layers described in the product README are not yet wired — the Coordinate and Export tabs render demo content that matches the shape of the engine's output so the UI is ready the moment the engine lands.
