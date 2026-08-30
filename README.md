# OneIsland

**AI-powered resource intelligence for isolated island communities preparing for storms.**

OneIsland tracks water, food, solar power, and battery reserves across a community, predicts who will run short as a storm intensifies, and automatically matches surplus to need — critical medical dependencies protected first.

---

## The Problem

When a cyclone bears down on an island, the community often has *enough* water, food, and power to get through it collectively. The problem isn't total supply — it's distribution. One household has a full solar array and a spare battery bank; the neighbor down the road is on a failing grid connection with a dialysis machine and nine hours of water left. In the chaos of an approaching storm, nobody has the time — or the visibility — to work out who has what, who's actually in danger, and who's close enough to help.

Vanuatu is the sharpest possible illustration of this. It's the most cyclone-exposed nation on Earth relative to its population, hit by an average of 2–3 tropical cyclones every year, spread across dozens of islands where a shortage on one island can't be seen — let alone solved — from another. OneIsland is built and demonstrated against this real setting: five real Vanuatu locations, real households, and a real live weather feed for Port Vila, Efate.

## The Solution

OneIsland gives every household a resource profile — water, food, solar/battery capacity, shelter quality, household size and ages, and any critical medical equipment dependency — and runs a live pipeline against it as storm severity changes:

```
Live Conditions → Predict → Classify → Score → Match → Outcome
```

1. **Live Conditions** — read the current storm severity, either from live wind data or a manual override.
2. **Predict** — forecast how many hours of water, food, and power each household will actually have left at that severity.
3. **Classify** — bucket every household/resource pair into CRITICAL, SHORTAGE, BALANCED, or SURPLUS.
4. **Score** — rank shortages by urgency, life-safety equipment dependency, household vulnerability, and shelter strength.
5. **Match** — pair every shortage with the best available donor, nearest zone first, without ever draining a donor below their own safety margin.
6. **Outcome** — a ranked, explained list of recommended transfers, with an honest "needs outside aid" flag for anyone no one on the island can currently help.

The result is a live Console of recommended actions and a Storm Mode view that shows the entire reasoning pipeline end to end — built to be understood at a glance by a household, a first responder, or a judge.

## Key Features

- **Guided onboarding wizard** — a multi-step flow (not a raw form) that walks a household through zone(s), household size and ages, shelter quality, water/food in plain days, solar/battery capacity in kWh, an optional critical medical dependency, and an optional property photo.
- **Real-time weather integration** — live wind, gust, precipitation, and cloud cover for Port Vila, Efate, Vanuatu, pulled from [Open-Meteo](https://open-meteo.com) with no API key required.
- **Transparent, rules-based AI engine** — no black box. Every number in a prediction or a match is a plain, statable rule: consumption multipliers, classification thresholds, a weighted priority score, and a greedy zone-aware matcher with donor safety buffers and an honest unresolved-case fallback.
- **Live "Simulate Storm" demo trigger** — steps through calm → watch → warning → severe on demand, running the full pipeline against either live or simulated weather.
- **Zone Network** — five real Vanuatu locations (Efate, Espiritu Santo, Tanna, Malekula, Pentecost) with real adjacency, so matching prefers moving resources between neighboring islands before shipping them across the archipelago.
- **Supabase-backed auth, database, and storage** — email/password accounts, a shared `residents` table visible to the whole community, and photo uploads, all governed by row-level security.
- **Live sync across dashboards** — Supabase Realtime pushes resident and transfer changes to every open dashboard instantly, with no reload needed.
- **Confirmed-transfer audit trail** — every share a household confirms is logged and surfaced as recent activity, community-wide.

## AI Methodology — How the "AI" Actually Works

OneIsland's "AI" is a **deterministic, rules-based prediction and priority-scoring system — not a trained machine learning model.** That's a deliberate choice: in a life-safety context, a system that can be explained, audited, and trusted in a live demo is worth more than a marginally cleverer black box. Every number below is a fixed, statable rule.

**1. Prediction (`predictHours`)** — Each household's baseline hours of water/food/power remaining is adjusted for the current storm severity: a severity-specific consumption multiplier (people use more of everything as a storm worsens), a coastal water-contamination penalty once a storm turns Severe (surge risk to cisterns and tanks), a grid-down rule that caps grid-tied households to a small device-battery buffer once a storm reaches Warning strength, and a live-cloud-cover penalty that slows how fast independent solar/battery systems recharge.

**2. Classification (`classify`)** — Forecast hours are bucketed against fixed thresholds into **CRITICAL** (<6h), **SHORTAGE** (<16h), **BALANCED** (<36h), or **SURPLUS**.

**3. Priority scoring (`scorePriority`)** — Every CRITICAL/SHORTAGE household/resource pair gets a 0–100+ score built from four explainable terms: urgency (up to 60 pts, more as hours run out), a life-safety device dependency tied to that specific resource (+30 pts — this is what guarantees a household on an oxygen concentrator always outranks a household that's merely low on hours), any other special need (+10 pts), vulnerable household members like infants or elderly (+8 pts each, up to 24), and shelter strength (up to 10 pts for a weak shelter).

**4. Matching (`runMatching`)** — For each resource independently, recipients (CRITICAL/SHORTAGE, highest priority first) are matched greedily against donors (SURPLUS, with hours above a fixed reserve they're never drained below), preferring the same zone, then an adjacent zone, then anywhere on the island. Each transfer tops a recipient up toward a fixed target, never further. A recipient nobody can help is flagged as needing outside aid rather than silently dropped.

## Tech Stack

- **Frontend** — plain HTML, CSS, and vanilla JavaScript. No framework, no build step, no bundler — the entire app is static files served as-is.
- **Backend / data** — [Supabase](https://supabase.com) (Postgres database, email/password auth, row-level security, file storage, and Realtime), loaded client-side via CDN (`@supabase/supabase-js`).
- **Weather** — [Open-Meteo](https://open-meteo.com) live forecast API, no key or signup required.
- **Hosting** — deployed as a static site on [Vercel](https://vercel.com).

## Project Structure

```
index.html              Single-page app shell: landing, auth, onboarding, and the four-screen dashboard
css/
  styles.css             All styling for every screen and mode
js/
  config.js              Supabase project URL + publishable key, client init
  data.js                 Deployment config: island/region, zones, zone adjacency, the in-memory RESIDENTS array
  weather.js              Open-Meteo integration + severity derivation + simulated-storm presets
  engine.js                The prediction / classification / priority / matching pipeline (the "AI")
  residents-store.js      All Supabase reads/writes for residents, transfers, and photo uploads
  auth.js                  Thin wrapper around Supabase Auth (sign up / sign in / sign out / session state)
  onboarding.js            The guided multi-step onboarding wizard
  app.js                   App shell: screen/tab routing, rendering, realtime subscriptions, event wiring
supabase/
  schema.sql               Full database schema, RLS policies, seed data, storage bucket, and realtime setup
tests/
  engine.test.js           Unit tests for the matching engine
package.json               npm test script (node's built-in test runner)
```

## How to Run Locally

1. **Clone the repo**
   ```bash
   git clone <this-repo-url>
   cd OneIsland
   ```

2. **Set up a Supabase project**
   Create a free project at [supabase.com](https://supabase.com).

3. **Run the schema**
   Open your project's **SQL Editor**, paste the entire contents of [`supabase/schema.sql`](supabase/schema.sql), and run it once. This creates the `residents` and `transfers` tables, their RLS policies, the `resource-photos` storage bucket, seed demo households, and enables Realtime on both tables.

4. **Configure the client**
   In your Supabase dashboard, go to **Project Settings → API** and copy your project URL and publishable (anon) key into [`js/config.js`](js/config.js):
   ```js
   const SUPABASE_URL = "https://YOUR-PROJECT.supabase.co";
   const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_...";
   ```
   This key is safe to commit — it only grants what the RLS policies in `schema.sql` allow.

5. **Open the app**
   Since it's fully static, you can open [`index.html`](index.html) directly in a browser, or serve it with any static file server, e.g.:
   ```bash
   npx serve .
   ```

6. **Run the tests** (optional)
   ```bash
   npm test
   ```
   Runs the matching-engine unit tests via Node's built-in test runner.

## Data Model

Everything lives in one primary table, `public.residents`, plus an audit-trail table, `public.transfers`.

**`residents`** — one row per *property* (a household with a vacation home on another island has two rows, each an independent resource pool):

| Column | Meaning |
|---|---|
| `id`, `user_id` | Row id; owning auth user (nullable — seed/demo rows have no owner) |
| `name` | Household / property name |
| `zone` | One of the five Vanuatu locations (`efate`, `espiritu-santo`, `tanna`, `malekula`, `pentecost`) |
| `household_size`, `ages` | People in the household and their ages, used to derive vulnerability |
| `water`, `food` | Hours of water/food remaining, at the household's current rate of use |
| `solar_power`, `batteries` | Solar system and battery storage capacity, in kWh |
| `shelter` | `sturdy` \| `moderate` \| `weak` |
| `is_critical`, `device_type`, `critical_resource` | Whether the household depends on a life-safety device, what it is, and which resource (`power`/`water`/`food`) it depends on |
| `photo_url` | Public URL of an optional uploaded photo |
| `created_at` | Row timestamp |

**`transfers`** — an append-only audit log of every confirmed resource share (giver/receiver ids *and* a name snapshot, resource, amount, and the storm severity at confirmation time), so the log stays readable even if a resident row is later edited or removed.

**Row-level security**: anyone (including anonymous visitors) can **read** every row in both tables — the matching engine needs the full community picture to find surpluses, and the activity log is meant to be community-visible. A signed-in user can only **insert, update, or delete their own** `residents` rows; any signed-in user can **insert** a `transfers` row (a confirmed share is between two *other* households, not the confirming user's own property). The `resource-photos` storage bucket is public-read, authenticated-write, and owner-scoped for update/delete.

## Limitations

This is a hackathon prototype, not a production emergency-management system, and it shouldn't be represented as one:

- The demo runs against a small **seeded set of households** and a mix of live and simulated weather data — it has not been validated against real cyclone conditions or real community data at scale.
- The AI is **intentionally rules-based**, not a trained model. That's a deliberate transparency/reliability tradeoff for this use case, not a limitation to "fix" with ML — but it does mean the system only ever considers the factors we explicitly coded in.
- **Multi-island household support is simplified.** A household can register more than one property, but each is treated as its own fully independent resource pool addressed by a single primary zone — there's no logic yet for a household coordinating resources across its own multiple islands.
- The consumption multipliers, classification thresholds, and priority weights are reasoned estimates chosen to be explainable, not figures derived from real disaster-response data.

## Future Improvements

- Full multi-location support for a single household (coordinating, not just registering, more than one property)
- AI-generated natural-language explanations of each match, layered on top of the existing rule-based reasoning
- A dedicated presentation/demo mode with more control over pacing and scripted scenarios
- Offline-first support, so the app stays useful with the low or intermittent connectivity real storm conditions actually produce

## Team / Credits

- Palash Jakhotia
- Suhaas Mandava
