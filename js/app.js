/*
 * app.js
 * ------
 * UI wiring for OneIsland. Owns four top-level app modes — Landing, Auth,
 * Onboarding, Dashboard — toggled by setAppMode(), plus (inside Dashboard)
 * the three familiar screens (Console / Storm Mode / Profile) toggled by
 * the bottom tab bar. The actual "intelligence" lives
 * in engine.js — this file calls it and paints the result. Residents
 * come live from Supabase (residents-store.js); auth comes from auth.js;
 * the guided setup wizard lives in onboarding.js.
 *
 * Flow: Landing -> Auth (sign up/log in) -> Onboarding (first-time only)
 * -> Dashboard. Returning users with a completed profile skip straight
 * to the Dashboard on login. Editing later happens from the Profile tab,
 * which re-enters the same onboarding wizard pre-filled.
 */

// ---- Application state ----
let appMode = "landing";
let authMode = "signup";
let myPropertyRows = [];

let currentSeverity = "calm";
let currentWeather = null;
let currentForecast = [];
let currentMatchResult = { matches: [], unresolved: [] };
let simulationRunning = false;
let activeTab = "console";
let handledMatchKeys = new Set(); // recommendations the user has already shared/dismissed this scenario

document.addEventListener("DOMContentLoaded", init);

async function init() {
  wireLanding();
  wireAuthScreen();
  wireOnboardingControls();
  wireTabs();
  wireControls();
  wireProfileTab();

  onAuthChange(routeAfterAuthChange);
  await initAuth();
}

// ------------------------------------------------------------------
// App-level mode switching (Landing / Auth / Onboarding / Dashboard)
// ------------------------------------------------------------------

function setAppMode(mode) {
  appMode = mode;
  document.querySelectorAll(".app-mode").forEach(el => {
    el.classList.toggle("active", el.id === `mode-${mode}`);
  });
}

// ------------------------------------------------------------------
// Landing
// ------------------------------------------------------------------

function wireLanding() {
  document.getElementById("landingGetStartedBtn").addEventListener("click", () => enterAuthMode("signup"));
  document.getElementById("landingLogInBtn").addEventListener("click", () => enterAuthMode("login"));
}

// ------------------------------------------------------------------
// Auth screen (single form, toggles between sign-up and log-in)
// ------------------------------------------------------------------

function wireAuthScreen() {
  document.getElementById("authBackBtn").addEventListener("click", () => setAppMode("landing"));
  document.getElementById("authSwitchModeBtn").addEventListener("click", () => {
    authMode = authMode === "signup" ? "login" : "signup";
    updateAuthModeUI();
  });
  document.getElementById("authSubmitBtn").addEventListener("click", handleAuthSubmit);
}

function enterAuthMode(mode) {
  authMode = mode;
  updateAuthModeUI();
  document.getElementById("authError").classList.add("hidden");
  setAppMode("auth");
}

function updateAuthModeUI() {
  document.getElementById("authHeading").textContent = authMode === "signup" ? "Create your account" : "Log in";
  document.getElementById("authSubmitBtn").textContent = authMode === "signup" ? "Create Account" : "Log In";
  document.getElementById("authSwitchModeBtn").textContent = authMode === "signup"
    ? "Already have an account? Log in" : "Need an account? Sign up";
}

async function handleAuthSubmit() {
  const email = document.getElementById("authEmail").value.trim();
  const password = document.getElementById("authPassword").value;
  const errorEl = document.getElementById("authError");
  errorEl.classList.add("hidden");

  if (!email || password.length < 6) {
    errorEl.textContent = "Enter an email and a password of at least 6 characters.";
    errorEl.classList.remove("hidden");
    return;
  }

  const submitBtn = document.getElementById("authSubmitBtn");
  submitBtn.disabled = true;
  try {
    if (authMode === "signup") await signUp(email, password);
    else await signIn(email, password);
    // Routing to onboarding/dashboard happens automatically once the
    // auth state change fires — see routeAfterAuthChange().
  } catch (err) {
    errorEl.textContent = err.message || "Something went wrong.";
    errorEl.classList.remove("hidden");
  } finally {
    submitBtn.disabled = false;
  }
}

// ------------------------------------------------------------------
// Auth-driven routing: Landing <-> Onboarding <-> Dashboard
// ------------------------------------------------------------------

// Only these events should ever change which screen is showing — a
// background TOKEN_REFRESHED (Supabase does this periodically) must not
// silently reset someone mid-onboarding.
const AUTH_ROUTING_EVENTS = ["INITIAL_SESSION", "SIGNED_IN", "SIGNED_OUT"];

async function routeAfterAuthChange(user, event) {
  renderAuthStrip();
  if (event && !AUTH_ROUTING_EVENTS.includes(event)) return;

  if (!user) {
    setAppMode("landing");
    return;
  }

  let existingRows = [];
  try {
    existingRows = await fetchMyProperties(user.id);
  } catch (err) {
    console.error(err);
  }

  if (needsOnboarding(existingRows)) {
    startOnboarding(existingRows);
  } else {
    await enterDashboard();
  }
}

/** No property rows at all means this user has never completed onboarding. */
function needsOnboarding(rows) {
  return !rows || rows.length === 0;
}

/** Single entry point into the main app — called after login-with-existing-
 *  profile, and again after onboarding finishes. */
async function enterDashboard() {
  setAppMode("dashboard");
  switchTab("console");

  try {
    currentWeather = await fetchLiveWeather();
    currentSeverity = currentWeather.severity;
  } catch (err) {
    currentWeather = simulatedWeatherFor("calm");
    currentSeverity = "calm";
    console.warn("Live weather unavailable (no connection) — showing simulated calm baseline.", err);
  }

  try {
    RESIDENTS = await fetchResidents();
  } catch (err) {
    RESIDENTS = [];
    console.error("Could not load residents from Supabase — check js/config.js for your publishable key.", err);
  }

  recompute({ setStep: 0 });
  await renderProfileTab();
}

// ------------------------------------------------------------------
// Tab bar (inside Dashboard)
// ------------------------------------------------------------------

function wireTabs() {
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });
  document.getElementById("gotoStormBtn").addEventListener("click", () => switchTab("storm"));
}

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll(".tab-btn").forEach(btn => btn.classList.toggle("active", btn.dataset.tab === tab));
  document.querySelectorAll(".screen").forEach(screen => {
    screen.classList.toggle("active", screen.id === `screen-${tab}`);
  });
}

// ------------------------------------------------------------------
// Storm controls
// ------------------------------------------------------------------

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
      resetRecommendationState();
      recompute({ setStep: 4 });
    });
  });
}

async function resetToLiveConditions() {
  if (simulationRunning) return;
  resetRecommendationState();
  setButtonsDisabled(true);
  try {
    currentWeather = await fetchLiveWeather();
    currentSeverity = currentWeather.severity;
  } catch (err) {
    currentWeather = simulatedWeatherFor("calm");
    currentSeverity = "calm";
    console.warn("Live weather unavailable — reset to simulated calm baseline.", err);
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
  resetRecommendationState();
  switchTab("storm");

  const sequence = ["calm", "watch", "warning", "severe"];
  const startIndex = Math.max(0, sequence.indexOf(currentSeverity));

  for (let i = startIndex; i < sequence.length; i++) {
    currentSeverity = sequence[i];
    currentWeather = simulatedWeatherFor(currentSeverity);
    recompute({ setStep: 0 });
    await delay(600);
    recompute({ setStep: 1 });
    await delay(600);
    recompute({ setStep: 2 });
    await delay(600);
    recompute({ setStep: 3 });
    await delay(700);
    recompute({ setStep: 4 });
    await delay(i === sequence.length - 1 ? 0 : 450);
  }

  simulationRunning = false;
  setButtonsDisabled(false);
}

function setButtonsDisabled(disabled) {
  document.getElementById("simulateBtn").disabled = disabled;
  document.getElementById("resetBtn").disabled = disabled;
}

// ------------------------------------------------------------------
// Auth strip (top bar, Dashboard only)
// ------------------------------------------------------------------

function renderAuthStrip() {
  const el = document.getElementById("authStrip");
  if (!currentUser) { el.innerHTML = ""; return; }
  el.innerHTML = `
    <span class="as-email">${escapeHtml(currentUser.email)}</span>
    <button class="as-logout" id="logoutBtn" type="button">Log out</button>
  `;
  document.getElementById("logoutBtn").addEventListener("click", async () => {
    try { await signOut(); } catch (err) { console.error(err); }
  });
}

// ------------------------------------------------------------------
// Profile tab — read-only summary + "Edit My Profile"
// ------------------------------------------------------------------

function wireProfileTab() {
  document.getElementById("editProfileBtn").addEventListener("click", () => startOnboarding(myPropertyRows));
}

async function renderProfileTab() {
  const container = document.getElementById("profileSummary");
  container.innerHTML = `<p class="onb-hint">Loading your profile&hellip;</p>`;

  try {
    myPropertyRows = await fetchMyProperties(currentUser.id);
  } catch (err) {
    container.innerHTML = `<p class="onb-hint">Could not load your profile.</p>`;
    return;
  }
  if (!myPropertyRows || myPropertyRows.length === 0) {
    container.innerHTML = `<p class="onb-hint">No profile on file yet.</p>`;
    return;
  }

  const first = myPropertyRows[0];
  const householdHtml = `
    <div class="review-list">
      <div class="review-row"><span>Household</span><strong>${escapeHtml(String(first.name))}</strong></div>
      <div class="review-row"><span>Community</span><strong>${escapeHtml(ISLAND.name)}</strong></div>
    </div>`;

  const propertyCards = myPropertyRows.map(row => {
    const zone = ZONES.find(z => z.id === row.zone);
    const rows = [
      ["People", Number(row.household_size) > 0 ? `${row.household_size} (ages ${(row.ages || []).join(", ") || "—"})` : "None (vacation home)"],
      ["Solar", Number(row.solar_power) > 0 ? `${row.solar_power} kWh` : "None"],
      ["Battery", Number(row.batteries) > 0 ? `${row.batteries} kWh` : "None"],
      ["Critical need", row.is_critical ? row.device_type : "None"],
      ["Water", `${Math.round((row.water / 24) * 10) / 10} days`],
      ["Food", `${Math.round((row.food / 24) * 10) / 10} days`],
      ["Shelter", capitalize(row.shelter)]
    ];
    const photo = row.photo_url
      ? `<img class="resident-photo profile-photo" src="${row.photo_url}" alt="">`
      : "";
    return `
      <div class="property-card">
        <div class="property-card-head">${zone ? zone.name : row.zone}</div>
        ${photo}
        <div class="review-list">
          ${rows.map(([label, value]) => `<div class="review-row"><span>${label}</span><strong>${escapeHtml(String(value))}</strong></div>`).join("")}
        </div>
      </div>`;
  }).join("");

  container.innerHTML = householdHtml + propertyCards;
}

function capitalize(str) {
  return str ? str[0].toUpperCase() + str.slice(1) : str;
}

/** Runs the engine for currentSeverity and re-renders every screen. */
function recompute({ setStep }) {
  currentForecast = predictConditions(RESIDENTS, currentSeverity, currentWeather);
  currentMatchResult = runMatching(currentForecast);

  renderTopBar();
  renderConsole();
  renderStormScreen(setStep);
}

// ------------------------------------------------------------------
// Top bar — storm signal
// ------------------------------------------------------------------

function renderTopBar() {
  const severityIndex = SEVERITY_LEVELS.indexOf(currentSeverity); // 0..3
  const bars = document.getElementById("signalBars");
  bars.className = `signal-bars lit-${severityIndex + 1}`;
  document.getElementById("signalLabel").textContent = SEVERITY_INFO[currentSeverity].label;
}

// ------------------------------------------------------------------
// Console screen
// ------------------------------------------------------------------

function renderConsole() {
  const w = currentWeather;

  const heroSeverity = document.getElementById("heroSeverity");
  heroSeverity.textContent = SEVERITY_INFO[currentSeverity].label;
  heroSeverity.className = `hero-severity ${currentSeverity}`;
  document.getElementById("heroSub").textContent =
    `${Math.round(w.gustMph)} mph gusts · ${w.description}`;

  const source = document.getElementById("heroSource");
  source.className = `hero-source ${w.source === "live" ? "" : "simulated"}`;
  source.innerHTML = `<span class="dot"></span><span>${w.source === "live" ? "Live · Open-Meteo" : "Simulated scenario"}</span>`;

  const summaryBits = [`${Math.round(w.tempF)}&deg;F, ${w.precipIn.toFixed(1)}&Prime; precip`];
  if (currentSeverity === "calm") {
    summaryBits.push("no storm risk right now");
  } else {
    const shortages = currentForecast.filter(r => r.status === "CRITICAL" || r.status === "SHORTAGE");
    const unresolvedCount = currentMatchResult.unresolved.length;
    summaryBits.push(shortages.length === 1 ? "1 household short on supplies" : `${shortages.length} households short on supplies`);
    if (unresolvedCount > 0) {
      summaryBits.push(unresolvedCount === 1 ? "1 need outside aid" : `${unresolvedCount} need outside aid`);
    }
  }
  document.getElementById("consoleSummary").innerHTML = summaryBits.join(" &middot; ");

  renderRecommendations();
}

function matchKey(m) {
  return `${m.giver.id}|${m.receiver.id}|${m.resourceKey}`;
}

const RESOURCE_VERBS = { water: "water", food: "food", power: "power" };
let confirmingMatchKey = null; // rec card currently showing the before/after confirmation

function residentHours(resident, resourceKey) {
  const row = currentForecast.find(r => r.resident.id === resident.id && r.resourceKey === resourceKey);
  return row ? row.hours : 0;
}

function renderRecommendations() {
  const recsList = document.getElementById("recsList");

  if (currentSeverity === "calm") {
    confirmingMatchKey = null;
    recsList.innerHTML = `<div class="ft-empty">Conditions are calm &mdash; households don't need to trade resources yet. Recommendations appear once a storm watch or worse is in effect.</div>`;
    return;
  }

  const pending = currentMatchResult.matches.filter(m => !handledMatchKeys.has(matchKey(m)));

  if (pending.length === 0) {
    recsList.innerHTML = currentMatchResult.matches.length
      ? `<div class="ft-empty">All recommended transfers for this scenario have been handled.</div>`
      : `<div class="ft-empty">No shortages detected at this severity &mdash; every household is self-sufficient.</div>`;
    return;
  }

  recsList.innerHTML = pending.slice(0, 5).map(m => {
    const key = matchKey(m);
    if (key === confirmingMatchKey) {
      const giverBefore = residentHours(m.giver, m.resourceKey);
      const receiverBefore = residentHours(m.receiver, m.resourceKey);
      const giverAfter = Math.max(0, Math.round((giverBefore - m.amountHours) * 10) / 10);
      const receiverAfter = Math.round((receiverBefore + m.amountHours) * 10) / 10;
      return `
        <div class="rec-card" data-key="${key}">
          <div class="ft-kicker">Confirm &middot; ${RESOURCE_VERBS[m.resourceKey]}</div>
          <div class="rec-question">Confirm this transfer?</div>
          <div class="rec-confirm-row">
            <span class="rec-confirm-name">${m.giver.name}</span>
            <span class="rec-confirm-change loss">${formatResourceAmount(m.resourceKey, giverBefore)} &rarr; ${formatResourceAmount(m.resourceKey, giverAfter)}</span>
          </div>
          <div class="rec-confirm-row">
            <span class="rec-confirm-name">${m.receiver.name}</span>
            <span class="rec-confirm-change gain">${formatResourceAmount(m.resourceKey, receiverBefore)} &rarr; ${formatResourceAmount(m.resourceKey, receiverAfter)}</span>
          </div>
          <div class="rec-actions">
            <button class="rec-btn rec-btn-accept" data-action="confirm">Confirm share</button>
            <button class="rec-btn rec-btn-dismiss" data-action="cancel">Cancel</button>
          </div>
        </div>
      `;
    }
    return `
      <div class="rec-card" data-key="${key}">
        <div class="ft-kicker">Priority ${m.priorityScore} &middot; ${RESOURCE_VERBS[m.resourceKey]}</div>
        <div class="rec-question">
          Share <strong>${formatResourceAmount(m.resourceKey, m.amountHours)} of ${m.resourceKey}</strong>:
          <strong>${m.giver.name}</strong> &rarr; <strong>${m.receiver.name}</strong>?
        </div>
        <ul class="rec-reasons">
          ${m.reasoningPoints.map(point => `<li>${point}</li>`).join("")}
        </ul>
        <div class="rec-actions">
          <button class="rec-btn rec-btn-accept" data-action="accept">Share now</button>
          <button class="rec-btn rec-btn-dismiss" data-action="dismiss">Not now</button>
        </div>
      </div>
    `;
  }).join("");

  recsList.querySelectorAll(".rec-card").forEach(card => {
    const key = card.dataset.key;
    const match = currentMatchResult.matches.find(m => matchKey(m) === key);
    card.querySelectorAll(".rec-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const action = btn.dataset.action;
        if (action === "accept") {
          confirmingMatchKey = key;
        } else if (action === "cancel") {
          confirmingMatchKey = null;
        } else if (action === "confirm") {
          handledMatchKeys.add(key);
          confirmingMatchKey = null;
        } else if (action === "dismiss") {
          handledMatchKeys.add(key);
        }
        renderRecommendations();
      });
    });
  });
}

// ------------------------------------------------------------------
// Storm Mode screen
// ------------------------------------------------------------------

function renderStormScreen(activeStepIndex) {
  document.querySelectorAll(".severity-chip").forEach(chip => {
    chip.classList.toggle("active", chip.dataset.severity === currentSeverity);
  });

  document.querySelectorAll(".pv-step").forEach(stepEl => {
    const idx = Number(stepEl.dataset.step);
    stepEl.classList.remove("active", "done");
    if (idx < activeStepIndex) stepEl.classList.add("done");
    else if (idx === activeStepIndex) stepEl.classList.add("active");
  });

  document.getElementById("outcomeStrip").innerHTML = `
    <div class="o-tile"><div class="o-value mono">${currentMatchResult.matches.length}</div><div class="o-label">Matched</div></div>
    <div class="o-tile"><div class="o-value mono">${currentForecast.filter(r => r.status === "CRITICAL").length}</div><div class="o-label">Critical</div></div>
    <div class="o-tile"><div class="o-value mono">${currentMatchResult.unresolved.length}</div><div class="o-label">Unresolved</div></div>
  `;

  renderMatches();
}

function renderMatches() {
  const { matches, unresolved } = currentMatchResult;

  document.getElementById("matchesList").innerHTML = matches.length
    ? matches.map(m => `
      <div class="ticket receiver-${m.receiverStatus}">
        <div class="ticket-top">
          <div class="ticket-flow">
            <span class="tf-name">${m.giver.name}</span>
            <span class="tf-arrow">&rarr;</span>
            <span class="tf-name">${m.receiver.name}</span>
          </div>
          <span class="stamp">${m.resourceKey}</span>
        </div>
        <div class="ticket-perf">
          <div class="ticket-meta">
            <span>${formatResourceAmount(m.resourceKey, m.amountHours)} transferred · ${m.receiverStatus.toLowerCase()}</span>
            <span class="priority-tag">P${m.priorityScore}</span>
          </div>
          <div class="ticket-reason">${m.reasoningPoints.join(" ")}</div>
        </div>
      </div>
    `).join("")
    : `<div class="zone-hint">No shortages detected yet at this severity level.</div>`;

  const unresolvedHeading = document.getElementById("unresolvedHeading");
  unresolvedHeading.classList.toggle("hidden", unresolved.length === 0);

  document.getElementById("unresolvedList").innerHTML = unresolved.map(u => `
    <div class="unresolved-ticket">
      <strong>${u.resident.name}</strong> &mdash; ${u.status.toLowerCase()} ${u.resourceKey} shortage
      (${formatResourceAmount(u.resourceKey, u.hours)} left, priority ${u.priorityScore}). No island donor has spare capacity.
    </div>
  `).join("");
}

/** Called whenever the storm scenario changes, so stale accept/dismiss/confirm state doesn't carry over. */
function resetRecommendationState() {
  handledMatchKeys.clear();
  confirmingMatchKey = null;
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
