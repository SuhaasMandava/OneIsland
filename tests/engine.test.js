/*
 * engine.test.js
 * --------------
 * Unit tests for js/engine.js — the rules-based prediction/priority/
 * matching pipeline that is the whole "AI" in OneIsland. engine.js and
 * data.js are plain browser <script> files with no module system (they
 * share globals via index.html's script tags), so instead of rewriting
 * them for a bundler we load their real source into a sandboxed VM
 * context, exactly the way a browser would, and test the functions that
 * come out of it. Nothing about js/engine.js itself needs to change to
 * make it testable.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadEngine() {
  const sandbox = {};
  vm.createContext(sandbox);
  for (const file of ["data.js", "engine.js"]) {
    const code = fs.readFileSync(path.join(__dirname, "..", "js", file), "utf8");
    vm.runInContext(code, sandbox, { filename: file });
  }
  return sandbox;
}

const engine = loadEngine();

function buildResident(overrides = {}) {
  return {
    id: "r1",
    name: "Test Household",
    zone: "efate",
    powerSource: "independent",
    vulnerableMembers: 0,
    shelterRating: "sturdy",
    specialNeeds: [],
    resources: { water: { hours: 48 }, food: { hours: 48 }, power: { hours: 48 } },
    ...overrides
  };
}

// ---- classify() ----

test("classify: buckets hours into the right status at each boundary", () => {
  assert.equal(engine.classify(0), "CRITICAL");
  assert.equal(engine.classify(5.9), "CRITICAL");
  assert.equal(engine.classify(6), "SHORTAGE");       // CRITICAL threshold is exclusive
  assert.equal(engine.classify(15.9), "SHORTAGE");
  assert.equal(engine.classify(16), "BALANCED");       // SHORTAGE threshold is exclusive
  assert.equal(engine.classify(35.9), "BALANCED");
  assert.equal(engine.classify(36), "SURPLUS");        // BALANCED threshold is exclusive
  assert.equal(engine.classify(1000), "SURPLUS");
});

// ---- predictHours(): water/food consumption + coastal contamination ----

test("predictHours: higher severity divides hours by its consumption multiplier", () => {
  const resident = buildResident({ resources: { water: { hours: 100 }, food: { hours: 100 }, power: { hours: 100 } } });
  assert.equal(engine.predictHours(resident, "food", "calm"), 100);
  assert.equal(engine.predictHours(resident, "food", "watch"), Math.round((100 / 1.15) * 10) / 10);
  assert.equal(engine.predictHours(resident, "food", "severe"), Math.round((100 / 1.60) * 10) / 10);
});

test("predictHours: coastal zone + severe storm halves water, non-coastal is unaffected", () => {
  const coastalResident = buildResident({ zone: "efate" }); // efate is coastal in data.js
  const inlandResident = buildResident({ zone: "tanna" });  // tanna is not coastal

  const coastalWater = engine.predictHours(coastalResident, "water", "severe");
  const plainSevereWater = Math.round((48 / 1.60) * 10) / 10;
  assert.equal(coastalWater, Math.round(plainSevereWater * 0.5 * 10) / 10);

  const inlandWater = engine.predictHours(inlandResident, "water", "severe");
  assert.equal(inlandWater, plainSevereWater);
});

test("predictHours: coastal contamination only applies to water, and only at severe", () => {
  const coastalResident = buildResident({ zone: "efate" });
  const foodAtSevere = engine.predictHours(coastalResident, "food", "severe");
  assert.equal(foodAtSevere, Math.round((48 / 1.60) * 10) / 10); // unaffected by coastal rule

  const waterAtWarning = engine.predictHours(coastalResident, "water", "warning");
  assert.equal(waterAtWarning, Math.round((48 / 1.35) * 10) / 10); // no contamination below severe
});

// ---- predictHours(): grid power ----

test("predictHours: grid power is stable while the grid is up (calm/watch)", () => {
  const resident = buildResident({ powerSource: "grid" });
  assert.equal(engine.predictHours(resident, "power", "calm"), 30);
  assert.equal(engine.predictHours(resident, "power", "watch"), 30);
});

test("predictHours: grid power collapses to a small device-battery buffer once the grid is down", () => {
  const resident = buildResident({ powerSource: "grid", resources: { water: {hours:0}, food: {hours:0}, power: { hours: 48 } } });
  assert.equal(engine.predictHours(resident, "power", "warning"), Math.round((3 / 1.35) * 10) / 10);
  assert.equal(engine.predictHours(resident, "power", "severe"), Math.round((3 / 1.60) * 10) / 10);
});

// ---- predictHours(): independent (solar/battery) power + live cloud cover ----

test("predictHours: heavy cloud cover reduces independent power more than clear skies", () => {
  const resident = buildResident({ powerSource: "independent", resources: { water: {hours:0}, food: {hours:0}, power: { hours: 40 } } });
  const clear = engine.predictHours(resident, "power", "watch", { cloudCoverPct: 0 });
  const overcast = engine.predictHours(resident, "power", "watch", { cloudCoverPct: 100 });
  assert.ok(overcast < clear, `expected overcast (${overcast}) < clear (${clear})`);
  // Full overcast caps the penalty at SOLAR_CLOUD_PENALTY_MAX (30%) off the clear-sky figure,
  // within a small tolerance for the two figures rounding independently.
  assert.ok(Math.abs(overcast - clear * 0.7) < 0.2, `expected overcast (${overcast}) ~= 70% of clear (${clear})`);
});

test("predictHours: independent power without a weather reading falls back to the plain formula", () => {
  const resident = buildResident({ powerSource: "independent", resources: { water: {hours:0}, food: {hours:0}, power: { hours: 40 } } });
  assert.equal(engine.predictHours(resident, "power", "watch"), Math.round((40 / 1.15) * 10) / 10);
});

// ---- scorePriority() ----

test("scorePriority: a tied critical need outranks an untied one, which outranks none", () => {
  const noNeed = buildResident();
  const untiedNeed = buildResident({ specialNeeds: [{ label: "Wheelchair", resource: "water" }] });
  const tiedNeed = buildResident({ specialNeeds: [{ label: "Oxygen concentrator", resource: "power" }] });

  const scoreNone = engine.scorePriority(noNeed, "power", 20).breakdown.criticalNeed;
  const scoreUntied = engine.scorePriority(untiedNeed, "power", 20).breakdown.criticalNeed;
  const scoreTied = engine.scorePriority(tiedNeed, "power", 20).breakdown.criticalNeed;

  assert.equal(scoreNone, 0);
  assert.equal(scoreUntied, 10);
  assert.equal(scoreTied, 30);
});

test("scorePriority: urgency rises as hours fall, and clamps at the 0/60 bounds", () => {
  const resident = buildResident();
  assert.equal(engine.scorePriority(resident, "water", 0).breakdown.urgency, 60);
  assert.equal(engine.scorePriority(resident, "water", 40).breakdown.urgency, 0); // 60 - 40*2 would be negative
  assert.equal(engine.scorePriority(resident, "water", 10).breakdown.urgency, 40);
});

test("scorePriority: vulnerability contributes 8 per member, capped at 24", () => {
  assert.equal(engine.scorePriority(buildResident({ vulnerableMembers: 0 }), "water", 20).breakdown.vulnerability, 0);
  assert.equal(engine.scorePriority(buildResident({ vulnerableMembers: 2 }), "water", 20).breakdown.vulnerability, 16);
  assert.equal(engine.scorePriority(buildResident({ vulnerableMembers: 10 }), "water", 20).breakdown.vulnerability, 24);
});

test("scorePriority: total is the sum of its own breakdown", () => {
  const resident = buildResident({
    vulnerableMembers: 2,
    shelterRating: "weak",
    specialNeeds: [{ label: "Dialysis machine", resource: "water" }]
  });
  const { total, breakdown } = engine.scorePriority(resident, "water", 4);
  const expected = breakdown.urgency + breakdown.criticalNeed + breakdown.vulnerability + breakdown.shelter;
  assert.equal(total, expected);
});

// ---- runMatching() ----

function forecastRow({ resident, resourceKey, hours, status }) {
  const priority = engine.scorePriority(resident, resourceKey, hours);
  return { resident, resourceKey, hours, status, priorityScore: priority.total, scoreBreakdown: priority.breakdown };
}

test("runMatching: a critical recipient is matched to a surplus donor in the same zone", () => {
  const recipient = buildResident({ id: "recipient", zone: "efate" });
  const sameZoneDonor = buildResident({ id: "same-zone", name: "Same Zone Donor", zone: "efate" });
  const farDonor = buildResident({ id: "far", name: "Far Donor", zone: "tanna" }); // not adjacent to efate

  const forecast = [
    forecastRow({ resident: recipient, resourceKey: "power", hours: 2, status: "CRITICAL" }),
    forecastRow({ resident: sameZoneDonor, resourceKey: "power", hours: 60, status: "SURPLUS" }),
    forecastRow({ resident: farDonor, resourceKey: "power", hours: 60, status: "SURPLUS" })
  ];

  const { matches, unresolved } = engine.runMatching(forecast);

  assert.equal(unresolved.length, 0);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].giver.id, "same-zone");
  assert.equal(matches[0].receiver.id, "recipient");
  assert.ok(matches[0].amountHours > 0);
});

test("runMatching: prefers an adjacent zone over a non-adjacent one when no same-zone donor exists", () => {
  const recipient = buildResident({ id: "recipient", zone: "efate" });
  const adjacentDonor = buildResident({ id: "adjacent", name: "Adjacent Donor", zone: "pentecost" }); // adjacent to efate
  const farDonor = buildResident({ id: "far", name: "Far Donor", zone: "tanna" }); // not adjacent to efate

  const forecast = [
    forecastRow({ resident: recipient, resourceKey: "water", hours: 2, status: "CRITICAL" }),
    forecastRow({ resident: farDonor, resourceKey: "water", hours: 60, status: "SURPLUS" }),
    forecastRow({ resident: adjacentDonor, resourceKey: "water", hours: 60, status: "SURPLUS" })
  ];

  const { matches } = engine.runMatching(forecast);
  assert.equal(matches[0].giver.id, "adjacent");
});

test("runMatching: a critical need with no available donor is flagged unresolved, not dropped", () => {
  const recipient = buildResident({ id: "recipient", zone: "efate" });
  const forecast = [
    forecastRow({ resident: recipient, resourceKey: "food", hours: 1, status: "CRITICAL" })
  ];

  const { matches, unresolved } = engine.runMatching(forecast);
  assert.equal(matches.length, 0);
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].resident.id, "recipient");
  assert.equal(unresolved[0].resourceKey, "food");
});

test("runMatching: never drains a donor below the safety buffer", () => {
  const recipient = buildResident({ id: "recipient", zone: "efate" });
  const donor = buildResident({ id: "donor", zone: "efate" });
  // Donor has 25h; safety buffer is 20h, so only 5h is ever spareable.
  const forecast = [
    forecastRow({ resident: recipient, resourceKey: "water", hours: 1, status: "CRITICAL" }),
    forecastRow({ resident: donor, resourceKey: "water", hours: 45, status: "SURPLUS" })
  ];

  const { matches } = engine.runMatching(forecast);
  assert.equal(matches.length, 1);
  assert.ok(matches[0].amountHours <= 25, `transfer of ${matches[0].amountHours}h should leave the donor at or above their safety buffer`);
});

// ---- projectTimeToCritical() ----

function outlookHour(hoursFromNow, severity, cloudCoverPct = 50) {
  const gustBySeverity = { calm: 14, watch: 30, warning: 52, severe: 88 };
  return { hoursFromNow, severity, cloudCoverPct, gustMph: gustBySeverity[severity] };
}

test("projectTimeToCritical: finds the soonest hour the forecast alone would tip a resource critical", () => {
  // 9h of stock stays above CRITICAL (<6h) at calm/watch, but 9 / 1.60 = 5.6h at severe.
  const resident = buildResident({ resources: { water: { hours: 9 }, food: { hours: 9 }, power: { hours: 9 } } });
  const outlook = [outlookHour(1, "calm"), outlookHour(2, "watch"), outlookHour(3, "severe")];
  assert.equal(engine.projectTimeToCritical(resident, "water", outlook), 3);
});

test("projectTimeToCritical: returns null when nothing in the outlook would tip it critical", () => {
  const resident = buildResident({ resources: { water: { hours: 100 }, food: { hours: 100 }, power: { hours: 100 } } });
  const outlook = [outlookHour(1, "calm"), outlookHour(2, "watch"), outlookHour(3, "warning")];
  assert.equal(engine.projectTimeToCritical(resident, "water", outlook), null);
});

test("projectTimeToCritical: returns null for an empty or missing outlook", () => {
  const resident = buildResident();
  assert.equal(engine.projectTimeToCritical(resident, "water", []), null);
  assert.equal(engine.projectTimeToCritical(resident, "water", null), null);
});

// ---- formatResourceAmount() ----

test("formatResourceAmount: food shows as meals, power as kWh, water as hours", () => {
  assert.equal(engine.formatResourceAmount("food", 24), "3 meals");
  assert.equal(engine.formatResourceAmount("food", 8), "1 meal");
  assert.equal(engine.formatResourceAmount("water", 36), "36h");
});
