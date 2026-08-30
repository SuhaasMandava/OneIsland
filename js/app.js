/*
 * app.js
 * ------
 * UI wiring for OneIsland. This file owns the DOM: rendering the roster,
 * the weather bar, the pipeline stepper, and the AI decision log/matches.
 * All the actual "intelligence" lives in engine.js — this file just calls
 * it and paints the result.
 */

// ---- Application state ----
let currentSeverity = "calm";
let currentWeather = null;
let currentForecast = [];
let currentMatchResult = { matches: [], unresolved: [] };
let simulationRunning = false;

const PIPELINE_STEP_COUNT = 5;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  wireControls();
  renderResidentSkeleton(); // so the page looks alive immediately, before any fetch resolves

  try {
    currentWeather = await fetchLiveWeather();
    currentSeverity = currentWeather.severity;
    log(`Connected to Open-Meteo live forecast for ${ISLAND.name}.`);
  } catch (err) {
    currentWeather = simulatedWeatherFor("calm");
    currentSeverity = "calm";
    log("Live weather unavailable (no connection) — showing simulated calm baseline.");
  }

  recompute({ setStep: 0 });
}

function wireControls() {
  document.getElementById("simulateBtn").addEventListener("click", runStormSimulation);
  document.getElementById("resetBtn").addEventListener("click", resetToLiveConditions);

  document.querySelectorAll(".severity-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      if (simulationRunning) return;
      currentSeverity = chip.dataset.severity;
      currentWeather = currentWeather && currentWeather.source === "live" && currentSeverity === currentWeather.severity
        ? currentWeather
        : simulatedWeatherFor(currentSeverity);
      clearLog();
      log(`Manually set conditions to "${SEVERITY_INFO[currentSeverity].label}".`);
      recompute({ setStep: 4 });
    });
  });
}

async function resetToLiveConditions() {
  if (simulationRunning) return;
  clearLog();
  setButtonsDisabled(true);
  try {
    currentWeather = await fetchLiveWeather();
    currentSeverity = currentWeather.severity;
    log("Reset to live Open-Meteo conditions.");
  } catch (err) {
    currentWeather = simulatedWeatherFor("calm");
    currentSeverity = "calm";
    log("Live weather unavailable — reset to simulated calm baseline.");
  }
  recompute({ setStep: 0 });
  setButtonsDisabled(false);
}

/**
 * The centerpiece demo: walks the storm up through each severity level,
 * re-running the full predict -> detect -> match pipeline at every stage
 * so the audience can watch the outcome change live as conditions worsen.
 */
async function runStormSimulation() {
  if (simulationRunning) return;
  simulationRunning = true;
  setButtonsDisabled(true);
  clearLog();

  const sequence = ["calm", "watch", "warning", "severe"];
  const startIndex = Math.max(0, sequence.indexOf(currentSeverity));

  for (let i = startIndex; i < sequence.length; i++) {
    currentSeverity = sequence[i];
    currentWeather = simulatedWeatherFor(currentSeverity);
    log(`Conditions worsening: ${SEVERITY_INFO[currentSeverity].label} (${currentWeather.description}).`);
    recompute({ setStep: 0 });
    await delay(650);
    recompute({ setStep: 1 });
    await delay(650);
    recompute({ setStep: 2 });
    await delay(650);
    recompute({ setStep: 3 });
    await delay(750);
    recompute({ setStep: 4 });
    await delay(i === sequence.length - 1 ? 0 : 500);
  }

  log("Simulation complete: critical needs matched first, remaining surplus routed by priority.");
  simulationRunning = false;
  setButtonsDisabled(false);
}

function setButtonsDisabled(disabled) {
  document.getElementById("simulateBtn").disabled = disabled;
  document.getElementById("resetBtn").disabled = disabled;
}

/** Runs the engine for currentSeverity and re-renders every panel. */
function recompute({ setStep }) {
  currentForecast = predictConditions(RESIDENTS, currentSeverity);
  currentMatchResult = runMatching(currentForecast);

  renderWeather();
  renderStormBadge();
  renderSeverityChips();
  renderPipeline(setStep);
  renderResidents();
  renderSummary();
  renderMatches();

  if (setStep === 4) logPipelineOutcome();
}

function logPipelineOutcome() {
  const shortageCount = currentForecast.filter(r => r.status === "CRITICAL" || r.status === "SHORTAGE").length;
  const criticalCount = currentForecast.filter(r => r.status === "CRITICAL").length;
  log(`Detected ${shortageCount} shortages (${criticalCount} critical) across the island.`);
  log(`Ranking by urgency + critical-need dependency + vulnerability + shelter quality...`);

  currentMatchResult.matches.slice(0, 6).forEach(match => {
    log(
      `Matched: ${match.giver.name} -> ${match.receiver.name} ` +
      `(${match.amountHours}h ${match.resourceKey}, priority ${match.priorityScore}).`
    );
  });

  if (currentMatchResult.unresolved.length > 0) {
    log(`${currentMatchResult.unresolved.length} need(s) could not be matched locally — flagged for outside aid.`);
  }
}

// ------------------------------------------------------------------
// Rendering
// ------------------------------------------------------------------

function renderWeather() {
  const bar = document.getElementById("weatherBar");
  const w = currentWeather;
  const sourceLabel = w.source === "live" ? "LIVE — Open-Meteo" : "SIMULATED";

  bar.innerHTML = `
    <span class="weather-chip">${sourceLabel}</span>
    <span class="weather-chip">${Math.round(w.tempF)}&deg;F</span>
    <span class="weather-chip">Wind ${Math.round(w.windMph)} mph</span>
    <span class="weather-chip">Gusts ${Math.round(w.gustMph)} mph</span>
    <span class="weather-chip">${w.precipIn.toFixed(1)}" precip</span>
    <span class="weather-chip">${w.description}</span>
  `;
}

function renderStormBadge() {
  const badge = document.getElementById("stormStatusBadge");
  badge.className = `storm-badge ${currentSeverity}`;
  document.getElementById("stormStatusLabel").textContent = SEVERITY_INFO[currentSeverity].label;
}

function renderSeverityChips() {
  document.querySelectorAll(".severity-chip").forEach(chip => {
    chip.classList.toggle("active", chip.dataset.severity === currentSeverity);
  });
}

function renderPipeline(activeIndex) {
  document.querySelectorAll(".step").forEach(stepEl => {
    const idx = Number(stepEl.dataset.step);
    stepEl.classList.remove("active", "done");
    if (idx < activeIndex) stepEl.classList.add("done");
    else if (idx === activeIndex) stepEl.classList.add("active");
  });
}

function renderResidentSkeleton() {
  document.getElementById("residentRoster").innerHTML =
    `<p class="panel-subtitle">Loading resident roster&hellip;</p>`;
}

function renderResidents() {
  const container = document.getElementById("residentRoster");
  container.innerHTML = "";

  ZONES.forEach(zone => {
    const residentsInZone = RESIDENTS.filter(r => r.zone === zone.id);
    if (residentsInZone.length === 0) return;

    const group = document.createElement("div");
    group.className = "zone-group";
    group.innerHTML = `<div class="zone-title">${zone.name} ${zone.coastal ? '<span class="zone-coastal">Coastal</span>' : ""}</div>`;

    residentsInZone.forEach(resident => {
      group.appendChild(buildResidentCard(resident));
    });

    container.appendChild(group);
  });
}

function buildResidentCard(resident) {
  const card = document.createElement("div");
  card.className = "resident-card";

  const badges = [];
  resident.specialNeeds.forEach(n => badges.push(`<span class="badge badge-critical-need">${n.label}</span>`));
  if (resident.vulnerableMembers > 0) badges.push(`<span class="badge badge-vulnerable">${resident.vulnerableMembers} vulnerable</span>`);
  if (resident.shelterRating === "weak") badges.push(`<span class="badge badge-shelter-weak">Weak shelter</span>`);

  const resourceRows = RESOURCE_KEYS.map(key => {
    const row = currentForecast.find(r => r.resident.id === resident.id && r.resourceKey === key);
    const pct = Math.min(100, Math.round((row.hours / 48) * 100));
    return `
      <div class="resource-row">
        <span class="resource-label">${key}</span>
        <div class="resource-track"><div class="resource-fill ${row.status}" style="width:${pct}%"></div></div>
        <span class="resource-value ${row.status}">${row.hours}h</span>
      </div>`;
  }).join("");

  card.innerHTML = `
    <div class="resident-card-head">
      <div>
        <div class="resident-name">${resident.name}</div>
        <div class="resident-meta">${resident.householdSize > 0 ? resident.householdSize + " people" : "Community stock point"} &middot; ${resident.powerSource} power &middot; ${resident.shelterRating} shelter</div>
      </div>
    </div>
    ${badges.length ? `<div class="badge-row">${badges.join("")}</div>` : ""}
    <div class="resource-rows">${resourceRows}</div>
  `;
  return card;
}

function renderSummary() {
  const shortages = currentForecast.filter(r => r.status === "CRITICAL" || r.status === "SHORTAGE");
  const criticalNeedMatches = currentMatchResult.matches.filter(m =>
    m.receiver.specialNeeds.some(n => n.resource === m.resourceKey)
  );

  const stats = [
    { value: shortages.length, label: "Shortages detected", accent: "" },
    { value: criticalNeedMatches.length, label: "Critical needs protected first", accent: "accent-critical" },
    { value: currentMatchResult.matches.length, label: "Matches made", accent: "accent-teal" },
    { value: currentMatchResult.unresolved.length, label: "Needs outside aid", accent: "" }
  ];

  document.getElementById("summaryStats").innerHTML = stats.map(s => `
    <div class="stat-card ${s.accent}">
      <div class="stat-value">${s.value}</div>
      <div class="stat-label">${s.label}</div>
    </div>
  `).join("");
}

function renderMatches() {
  const list = document.getElementById("matchesList");
  const { matches, unresolved } = currentMatchResult;

  list.innerHTML = matches.length
    ? matches.map(m => `
      <div class="match-card receiver-${m.receiverStatus}">
        <div class="match-flow">
          <span>${m.giver.name}</span>
          <span class="match-arrow">&rarr;</span>
          <span>${m.receiver.name}</span>
          <span class="match-resource-tag">${m.resourceKey}</span>
          <span class="priority-pill">Priority ${m.priorityScore}</span>
        </div>
        <div class="match-meta">${m.amountHours}h of ${m.resourceKey} transferred &middot; recipient status: ${m.receiverStatus}</div>
        <div class="match-reasoning">${m.reasoning}</div>
      </div>
    `).join("")
    : `<p class="panel-subtitle">No shortages detected yet at this severity level.</p>`;

  const unresolvedHeading = document.getElementById("unresolvedHeading");
  const unresolvedList = document.getElementById("unresolvedList");

  unresolvedHeading.classList.toggle("hidden", unresolved.length === 0);
  unresolvedList.innerHTML = unresolved.map(u => `
    <div class="unresolved-card">
      <strong>${u.resident.name}</strong> &mdash; ${u.status} ${u.resourceKey} shortage (${u.hours}h left, priority ${u.priorityScore}).
      No island donor has spare capacity &mdash; recommend requesting outside relief supply.
    </div>
  `).join("");
}

// ------------------------------------------------------------------
// Decision log helpers
// ------------------------------------------------------------------

function log(message) {
  const el = document.getElementById("decisionLog");
  const empty = el.querySelector(".log-empty");
  if (empty) empty.remove();

  const line = document.createElement("div");
  line.className = "log-line";
  line.textContent = `> ${message}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function clearLog() {
  document.getElementById("decisionLog").innerHTML = `<div class="log-empty">Waiting for next event&hellip;</div>`;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
