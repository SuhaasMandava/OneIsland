/*
 * data.js
 * -------
 * Static reference data for OneIsland: the island itself and its five
 * neighborhoods. Resident data used to live here as a hardcoded array —
 * it now comes live from the Supabase "residents" table instead (see
 * residents-store.js), so the app reflects real sign-ups and edits.
 *
 * Every resident's resources are stored as "hours" — i.e. how many hours
 * of that resource remain at their CURRENT (pre-storm) rate of use. This
 * keeps the math in engine.js simple and easy to explain to judges:
 * a storm changes consumption/supply, which changes the hours remaining.
 */

// The demo island. Coordinates are real (Key West, FL) so we can pull a
// genuine live marine forecast from Open-Meteo — but the "island" itself
// (name, residents, zones) is fictional for the demo.
const ISLAND = {
  name: "Kailani Island",
  region: "Straits of Kailani",
  lat: 24.5551,
  lon: -81.7800
};

// Five neighborhoods ("zones") arranged in a ring around the island.
// coastal: true means the zone is exposed to storm surge, which matters
// for the water-contamination rule in engine.js.
const ZONES = [
  { id: "harbor-point",      name: "Harbor Point",       short: "Harbor Pt.", coastal: true },
  { id: "marina-row",        name: "Marina Row",         short: "Marina Row", coastal: true },
  { id: "fishermans-wharf",  name: "Fisherman's Wharf",  short: "The Wharf",  coastal: true },
  { id: "old-town",          name: "Old Town",           short: "Old Town",   coastal: false },
  { id: "highlands",         name: "Highlands",          short: "Highlands", coastal: false }
];

// Which zones border which. Used by the matching engine to prefer moving
// resources between neighbors before shipping them across the island.
const ZONE_ADJACENCY = {
  "harbor-point":     ["marina-row", "highlands"],
  "marina-row":       ["harbor-point", "fishermans-wharf"],
  "fishermans-wharf": ["marina-row", "old-town"],
  "old-town":         ["fishermans-wharf", "highlands"],
  "highlands":        ["old-town", "harbor-point"]
};

/*
 * Resident shape (as produced by residents-store.js's mapResidentRow(),
 * fed by the Supabase "residents" table — see supabase/schema.sql):
 *  id              row uuid
 *  userId          the owning auth user, or null for seed/demo rows
 *  name            person / household name shown in the UI
 *  zone            one of ZONES[].id
 *  householdSize   always 1 in this schema (one row per signed-up person)
 *  powerSource     "grid" | "independent" (solar and/or battery backup)
 *  resources.water.hours   hours of water remaining at current use
 *  resources.food.hours    hours of food remaining at current use
 *  resources.power.hours   hours of power remaining at current use
 *  shelterRating   "sturdy" | "moderate" | "weak"
 *  vulnerableMembers  always 0 — this schema doesn't track household
 *                     composition, so this scoring term is inactive
 *  specialNeeds    array of { label, resource } — at most one entry,
 *                  derived from is_critical + device_type
 *  photoUrl        public URL of an uploaded photo, or null
 *
 * This mutable array is populated by app.js on startup (and again after
 * any sign-up/edit) via fetchResidents() in residents-store.js.
 */
let RESIDENTS = [];
