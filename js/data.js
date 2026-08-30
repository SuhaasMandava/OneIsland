/*
 * data.js
 * -------
 * Static reference data for OneIsland: Vanuatu and its five demo regions.
 * Vanuatu is real — the most cyclone-exposed nation in the Pacific,
 * averaging 2-3 tropical cyclones a year — which is why it's the setting
 * for this demo rather than a fictional backdrop. Resident data used to
 * live here as a hardcoded array — it now comes live from the Supabase
 * "residents" table instead (see residents-store.js), populated through
 * the guided onboarding flow (see onboarding.js).
 *
 * Every resident's resources are stored as "hours" — i.e. how many hours
 * of that resource remain at their CURRENT (pre-storm) rate of use. This
 * keeps the math in engine.js simple and easy to explain to judges:
 * a storm changes consumption/supply, which changes the hours remaining.
 */

// The demo nation. Coordinates are Port Vila, the capital on Efate, so we
// can pull a genuine live forecast for Vanuatu from Open-Meteo.
const ISLAND = {
  name: "Vanuatu",
  region: "South Pacific Ocean",
  lat: -17.7333,
  lon: 168.3167
};

// Five real Vanuatu islands, arranged in a ring for the Zone Network map.
// coastal: true means the main population center is a low-lying harbor
// town exposed to storm surge, which matters for the water-contamination
// rule in engine.js — Efate (Port Vila) and Santo (Luganville) are
// Vanuatu's two coastal port towns; Tanna, Malekula and Pentecost are
// framed here as more rural/interior village communities.
const ZONES = [
  { id: "efate",          name: "Efate",           short: "Efate",     coastal: true },
  { id: "espiritu-santo",  name: "Espiritu Santo",  short: "Santo",     coastal: true },
  { id: "tanna",           name: "Tanna",           short: "Tanna",     coastal: false },
  { id: "malekula",        name: "Malekula",        short: "Malekula",  coastal: false },
  { id: "pentecost",       name: "Pentecost",       short: "Pentecost", coastal: false }
];

// Which islands border which in the Zone Network ring. Used by the
// matching engine to prefer moving resources between neighbors before
// shipping them across the archipelago.
const ZONE_ADJACENCY = {
  "efate":         ["espiritu-santo", "pentecost"],
  "espiritu-santo": ["efate", "tanna"],
  "tanna":         ["espiritu-santo", "malekula"],
  "malekula":      ["tanna", "pentecost"],
  "pentecost":     ["malekula", "efate"]
};

/*
 * Resident shape (as produced by residents-store.js's mapResidentRow(),
 * fed by the Supabase "residents" table — see supabase/schema.sql):
 *  id              row uuid
 *  userId          the owning auth user, or null for seed/demo rows
 *  name            person / household name shown in the UI
 *  zone            primary island — zones[0] — used by the matching
 *                  engine and the Zone Network map (see the note in
 *                  residents-store.js about why only one zone drives
 *                  matching even though onboarding allows several)
 *  zones           every island this household selected during onboarding
 *  householdSize   number of people in the household
 *  ages            ages of household members, as entered during onboarding
 *  powerSource     "grid" | "independent" (solar and/or battery backup)
 *  resources.water.hours   hours of water remaining at current use
 *  resources.food.hours    hours of food remaining at current use
 *  resources.power.hours   hours of power remaining at current use
 *  shelterRating   "sturdy" | "moderate" | "weak"
 *  vulnerableMembers  count of household members under 5 or 65+, derived
 *                     from `ages` (see CHILD/ELDERLY thresholds in
 *                     residents-store.js)
 *  specialNeeds    array of { label, resource } — at most one entry,
 *                  derived from is_critical + device_type
 *  photoUrl        public URL of an uploaded photo, or null
 *
 * This mutable array is populated by app.js on entering the dashboard
 * (and again after onboarding/edits) via fetchResidents() in
 * residents-store.js.
 */
let RESIDENTS = [];
