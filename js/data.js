/*
 * data.js
 * -------
 * Seed data for OneIsland. In a real deployment this would come from a
 * database + IoT sensors / household check-ins. For this demo it's a
 * plain in-memory JavaScript array so the whole app runs with zero setup.
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
  { id: "harbor-point",      name: "Harbor Point",       coastal: true },
  { id: "marina-row",        name: "Marina Row",         coastal: true },
  { id: "fishermans-wharf",  name: "Fisherman's Wharf",  coastal: true },
  { id: "old-town",          name: "Old Town",           coastal: false },
  { id: "highlands",         name: "Highlands",          coastal: false }
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
 * Each resident record:
 *  id              unique string
 *  name            household / person name shown in the UI
 *  zone            one of ZONES[].id
 *  householdSize   number of people living there
 *  powerSource     "grid" | "solar" | "generator" | "well"
 *                  (affects how the storm hits their power supply)
 *  resources.water.hours   hours of water remaining at current use
 *  resources.food.hours    hours of food remaining at current use
 *  resources.power.hours   hours of power remaining at current use
 *  shelterRating   "sturdy" | "moderate" | "weak"
 *  vulnerableMembers  count of household members needing extra care
 *                     (infant, elderly, disabled, medically fragile)
 *  specialNeeds    array of { label, resource } — a dependency on a
 *                  specific resource that must never be allowed to run out
 *                  (resource is null for needs not tied to one resource)
 */
const RESIDENTS = [
  // ---- Harbor Point (coastal, dense) ----
  {
    id: "sione-kavana", name: "Sione Kavana", zone: "harbor-point",
    householdSize: 1, powerSource: "grid",
    resources: { water: { hours: 30 }, food: { hours: 50 }, power: { hours: 4 } },
    shelterRating: "sturdy", vulnerableMembers: 1,
    specialNeeds: [{ label: "Oxygen concentrator (powered medical device)", resource: "power" }]
  },
  {
    id: "tavita-household", name: "Tavita Household", zone: "harbor-point",
    householdSize: 4, powerSource: "grid",
    resources: { water: { hours: 40 }, food: { hours: 60 }, power: { hours: 6 } },
    shelterRating: "moderate", vulnerableMembers: 1, specialNeeds: []
  },
  {
    id: "fale-family", name: "Fale Family", zone: "harbor-point",
    householdSize: 5, powerSource: "solar",
    resources: { water: { hours: 90 }, food: { hours: 40 }, power: { hours: 50 } },
    shelterRating: "sturdy", vulnerableMembers: 0, specialNeeds: []
  },

  // ---- Marina Row (coastal) ----
  {
    id: "captain-ioane", name: "Captain Ioane", zone: "marina-row",
    householdSize: 2, powerSource: "generator",
    resources: { water: { hours: 20 }, food: { hours: 15 }, power: { hours: 70 } },
    shelterRating: "moderate", vulnerableMembers: 0, specialNeeds: []
  },
  {
    id: "litia-maafu", name: "Litia Ma'afu", zone: "marina-row",
    householdSize: 3, powerSource: "grid",
    resources: { water: { hours: 10 }, food: { hours: 45 }, power: { hours: 8 } },
    shelterRating: "weak", vulnerableMembers: 2, specialNeeds: []
  },
  {
    id: "marina-row-boarding-house", name: "Marina Row Boarding House", zone: "marina-row",
    householdSize: 8, powerSource: "grid",
    resources: { water: { hours: 18 }, food: { hours: 20 }, power: { hours: 5 } },
    shelterRating: "weak", vulnerableMembers: 0, specialNeeds: []
  },

  // ---- Fisherman's Wharf (coastal) ----
  {
    id: "talia-fishing-coop", name: "Talia & Sons Fishing Co-op", zone: "fishermans-wharf",
    householdSize: 6, powerSource: "generator",
    resources: { water: { hours: 80 }, food: { hours: 30 }, power: { hours: 60 } },
    shelterRating: "sturdy", vulnerableMembers: 0, specialNeeds: []
  },
  {
    id: "vika-faleolo", name: "Vika Faleolo", zone: "fishermans-wharf",
    householdSize: 1, powerSource: "solar",
    resources: { water: { hours: 12 }, food: { hours: 10 }, power: { hours: 15 } },
    shelterRating: "weak", vulnerableMembers: 1,
    specialNeeds: [{ label: "Insulin refrigeration (requires power)", resource: "power" }]
  },
  {
    id: "wharf-community-store", name: "Wharf Community Store", zone: "fishermans-wharf",
    householdSize: 0, powerSource: "generator",
    resources: { water: { hours: 100 }, food: { hours: 90 }, power: { hours: 20 } },
    shelterRating: "sturdy", vulnerableMembers: 0, specialNeeds: []
  },

  // ---- Old Town (inland) ----
  {
    id: "reverend-paea", name: "Reverend Paea (Church Shelter)", zone: "old-town",
    householdSize: 3, powerSource: "grid",
    resources: { water: { hours: 35 }, food: { hours: 55 }, power: { hours: 6 } },
    shelterRating: "sturdy", vulnerableMembers: 0, specialNeeds: []
  },
  {
    id: "ana-petero", name: "Ana & Petero", zone: "old-town",
    householdSize: 4, powerSource: "grid",
    resources: { water: { hours: 8 }, food: { hours: 12 }, power: { hours: 5 } },
    shelterRating: "moderate", vulnerableMembers: 2, specialNeeds: []
  },
  {
    id: "old-town-bakery", name: "Old Town Bakery", zone: "old-town",
    householdSize: 2, powerSource: "generator",
    resources: { water: { hours: 50 }, food: { hours: 120 }, power: { hours: 40 } },
    shelterRating: "sturdy", vulnerableMembers: 0, specialNeeds: []
  },

  // ---- Highlands (inland, elevated — safest ground on the island) ----
  {
    id: "kealoha-homestead", name: "Kealoha Homestead", zone: "highlands",
    householdSize: 5, powerSource: "well",
    resources: { water: { hours: 150 }, food: { hours: 70 }, power: { hours: 80 } },
    shelterRating: "sturdy", vulnerableMembers: 0, specialNeeds: []
  },
  {
    id: "nurse-faimalo", name: "Nurse Faimalo (Retired)", zone: "highlands",
    householdSize: 1, powerSource: "grid",
    resources: { water: { hours: 25 }, food: { hours: 40 }, power: { hours: 7 } },
    shelterRating: "sturdy", vulnerableMembers: 0, specialNeeds: []
  },
  {
    id: "highlands-youth-hostel", name: "Highlands Youth Hostel", zone: "highlands",
    householdSize: 10, powerSource: "grid",
    resources: { water: { hours: 14 }, food: { hours: 18 }, power: { hours: 6 } },
    shelterRating: "moderate", vulnerableMembers: 0, specialNeeds: []
  }
];
