/*
 * app.js
 * ------
 * UI wiring for OneIsland. Owns five top-level app modes — Landing, Auth,
 * Load Error, Onboarding, Dashboard — toggled by setAppMode(), plus
 * (inside Dashboard) the four familiar screens (Console / Zones / Storm
 * Mode / Profile) toggled by the bottom tab bar. The actual "intelligence" lives
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
let currentHourlyOutlook = []; // next-24h projected severity/cloud cover, see fetchHourlyOutlook()
let currentForecast = [];
let currentMatchResult = { matches: [], unresolved: [] };
let simulationRunning = false;
let activeTab = "console";
let currentPipelineStep = 0; // last-rendered Storm Mode pipeline step, preserved across realtime refreshes
let liveChannels = []; // active Supabase realtime subscriptions — see subscribeToLiveUpdates()
let recentActivity = []; // confirmed transfers, newest first — see logTransfer()/renderRecentActivity()
let residentsLoadError = false; // true when fetchResidents() failed — Console shows a retry banner instead of a falsely-reassuring "all clear"
let weatherLoadError = false; // true when the live Open-Meteo fetch failed/timed out — Console shows a fallback banner distinct from an intentional manual simulation
let handledMatchKeys = new Set(); // recommendations the user has already shared/dismissed this scenario

/** Races a promise against a timeout so a slow/hanging Supabase request
 *  eventually surfaces as a retry-able error instead of spinning forever. */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out — check your connection.`)), ms))
  ]);
}

document.addEventListener("DOMContentLoaded", init);

async function init() {
  wireLanding();
  wireAuthScreen();
  wireLoadErrorScreen();
  wireOnboardingControls();
  wireTabs();
  wireControls();
  wireProfileTab();

  onAuthChange(routeAfterAuthChange);
  await initAuth();
}

function wireLoadErrorScreen() {
  document.getElementById("loadErrorRetryBtn").addEventListener("click", () => routeAfterAuthChange(currentUser, "SIGNED_IN"));
  document.getElementById("loadErrorLogoutBtn").addEventListener("click", async () => {
    try { await signOut(); } catch (err) { console.error(err); }
  });
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
  submitBtn.textContent = authMode === "signup" ? "Creating account…" : "Logging in…";
  try {
    if (authMode === "signup") await withTimeout(signUp(email, password), 12000, "Sign up");
    else await withTimeout(signIn(email, password), 12000, "Log in");
    // Routing to onboarding/dashboard happens automatically once the
    // auth state change fires — see routeAfterAuthChange().
  } catch (err) {
    errorEl.textContent = err.message || "Something went wrong.";
    errorEl.classList.remove("hidden");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = authMode === "signup" ? "Create Account" : "Log In";
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

  let existingRows;
  try {
    existingRows = await withTimeout(fetchMyProperties(user.id), 12000, "Loading your account");
  } catch (err) {
    // Don't guess: routing an existing user into the first-time wizard on a
    // transient failure would let them "finish" it and have
    // saveMyProperties() delete their real rows and replace them with a
    // blank re-fill. Show a retry screen instead of picking a mode.
    console.error("Could not load this account's properties — refusing to guess whether onboarding is needed.", err);
    setAppMode("loaderror");
    return;
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
  showDashboardLoadingState();

  try {
    currentWeather = await fetchLiveWeather();
    currentSeverity = currentWeather.severity;
    weatherLoadError = false;
  } catch (err) {
    currentWeather = simulatedWeatherFor("calm");
    currentSeverity = "calm";
    weatherLoadError = true;
    console.warn("Live weather unavailable (no connection) — showing simulated calm baseline.", err);
  }

  try {
    RESIDENTS = await withTimeout(fetchResidents(), 12000, "Loading households");
    residentsLoadError = false;
  } catch (err) {
    RESIDENTS = [];
    residentsLoadError = true;
    console.error("Could not load residents from Supabase — check js/config.js for your publishable key.", err);
  }

  try {
    currentHourlyOutlook = await fetchHourlyOutlook(24);
  } catch (err) {
    currentHourlyOutlook = [];
    console.warn("Hourly outlook unavailable (no connection) — 24-hour projections will be hidden.", err);
  }

  try {
    recentActivity = await withTimeout(fetchRecentTransfers(5), 12000, "Loading recent activity");
  } catch (err) {
    recentActivity = [];
    console.warn("Could not load recent activity.", err);
  }
  renderRecentActivity();

  recompute({ setStep: 0 });
  await renderProfileTab();
  subscribeToLiveUpdates();
}

/** Placeholder content shown the instant the dashboard mounts, before any
 *  network call resolves — so a slow connection shows "loading", not a
 *  blank/broken-looking screen. Every section here gets overwritten once
 *  its real data (or a proper error/empty state) is ready. */
function showDashboardLoadingState() {
  document.getElementById("consoleSummary").innerHTML =
    `<span class="loading-inline"><span class="spinner" aria-hidden="true"></span>Loading current conditions&hellip;</span>`;
  document.getElementById("recsList").innerHTML = `<div class="ft-empty">Loading recommendations&hellip;</div>`;
  document.getElementById("outlookList").innerHTML = `<div class="ft-empty">Loading outlook&hellip;</div>`;
  document.getElementById("recentActivityList").innerHTML = `<div class="ft-empty">Loading activity&hellip;</div>`;
}

/**
 * Persists a "marked as contacted" entry to Supabase (see recordTransfer()
 * in residents-store.js) and prepends it to the on-screen activity log
 * right away, rather than waiting on the round-trip. This only records
 * that a contact was made — the actual transfer happens off-app, by the
 * phone call the recommendation's contact info was there for.
 */
function logTransfer(match) {
  const entry = {
    giver_name: match.giver.name,
    receiver_name: match.receiver.name,
    resource_key: match.resourceKey,
    amount_hours: match.amountHours,
    severity: currentSeverity,
    created_at: new Date().toISOString()
  };
  recentActivity = [entry, ...recentActivity].slice(0, 5);
  renderRecentActivity();

  recordTransfer({
    giver: match.giver, receiver: match.receiver,
    resourceKey: match.resourceKey, amountHours: match.amountHours,
    severity: currentSeverity
  }).catch(err => console.warn("Could not save this transfer to the activity log.", err));
}

function renderRecentActivity() {
  const container = document.getElementById("recentActivityList");
  if (!container) return;

  if (recentActivity.length === 0) {
    container.innerHTML = `<div class="ft-empty">No contacts made yet — households you've marked as contacted will show up here.</div>`;
    return;
  }

  container.innerHTML = recentActivity.map(t => `
    <div class="activity-row">
      <span class="activity-flow">
        <strong>${escapeHtml(t.giver_name)}</strong> &rarr; <strong>${escapeHtml(t.receiver_name)}</strong>
      </span>
      <span class="activity-meta">${formatResourceAmount(t.resource_key, t.amount_hours)} of ${t.resource_key} &middot; ${SEVERITY_INFO[t.severity] ? SEVERITY_INFO[t.severity].label : t.severity}</span>
    </div>
  `).join("");
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
  document.querySelectorAll(".tab-btn").forEach(btn => {
    const isActive = btn.dataset.tab === tab;
    btn.classList.toggle("active", isActive);
    if (isActive) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  });
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
    weatherLoadError = false;
  } catch (err) {
    currentWeather = simulatedWeatherFor("calm");
    currentSeverity = "calm";
    weatherLoadError = true;
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
    teardownLiveUpdates();
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
  container.innerHTML = `<p class="onb-hint loading-inline"><span class="spinner" aria-hidden="true"></span>Loading your profile&hellip;</p>`;

  try {
    myPropertyRows = await withTimeout(fetchMyProperties(currentUser.id), 12000, "Loading your profile");
  } catch (err) {
    console.error("Could not load profile.", err);
    container.innerHTML = `<p class="onb-hint summary-error">Could not load your profile. <button type="button" class="link-btn" id="retryProfileBtn">Retry</button></p>`;
    document.getElementById("retryProfileBtn").addEventListener("click", renderProfileTab);
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
      <div class="review-row"><span>Phone</span><strong>${escapeHtml(String(first.phone || "—"))}</strong></div>
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
      ["Shelter", capitalize(row.shelter)],
      ["Address", row.address || "—"]
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

/** Re-attempts loading household data after a failed fetch, without re-running the whole dashboard entry sequence. */
async function retryLoadResidents() {
  try {
    RESIDENTS = await withTimeout(fetchResidents(), 12000, "Loading households");
    residentsLoadError = false;
  } catch (err) {
    RESIDENTS = [];
    residentsLoadError = true;
    console.error("Retry failed — still could not load residents from Supabase.", err);
  }
  recompute({ setStep: currentPipelineStep });
}

/**
 * True if a resident row belongs to the signed-in user. The matching
 * engine itself always runs against every resident on the island — it has
 * to, to find the best real donor for a shortage — but nothing displayed
 * to a signed-in user should show them a match, ticket, or contact detail
 * (phone/address) for two OTHER households that don't involve them at all.
 * "Bob's family -> Palash's family" is fine to show Palash; "John's family
 * -> Bob's family" is not, even though the engine correctly computed it as
 * the best match for John.
 */
function isMine(resident) {
  return !!currentUser && !!resident && resident.userId === currentUser.id;
}

function involvesMe(match) {
  return isMine(match.giver) || isMine(match.receiver);
}

/** Runs the engine for currentSeverity and re-renders every screen. */
function recompute({ setStep }) {
  currentPipelineStep = setStep;
  currentForecast = predictConditions(RESIDENTS, currentSeverity, currentWeather);
  currentMatchResult = runMatching(currentForecast);

  renderTopBar();
  renderConsole();
  renderOutlook();
  renderNetwork();
  renderStormScreen(setStep);
}

// ------------------------------------------------------------------
// Zones screen — a status-at-a-glance map. Deliberately simplified:
// no click-to-drill household detail, just each island's worst current
// status and how many households there are short on something, since
// this is a geographic problem (islands, zone-adjacency routing) that
// deserves a spatial view alongside the list-based Console/Storm screens.
// ------------------------------------------------------------------

const NETWORK_CENTER = { x: 150, y: 160 };
const NETWORK_RADIUS = 95;

function zonePosition(index) {
  const angleDeg = -90 + index * (360 / ZONES.length);
  const angleRad = (angleDeg * Math.PI) / 180;
  return {
    x: NETWORK_CENTER.x + NETWORK_RADIUS * Math.cos(angleRad),
    y: NETWORK_CENTER.y + NETWORK_RADIUS * Math.sin(angleRad)
  };
}

/** A zone with zero residents has no status at all — distinct from a zone
 *  full of households that all happen to be BALANCED, which zoneStatus()
 *  would otherwise return for both, making an empty zone look identical to
 *  a healthy one. */
function zoneHasResidents(zoneId) {
  return RESIDENTS.some(r => r.zone === zoneId);
}

/** Worst-case status for a zone, used to color its network node. */
function zoneStatus(zoneId) {
  const rows = currentForecast.filter(r => r.resident.zone === zoneId);
  if (rows.some(r => r.status === "CRITICAL")) return "CRITICAL";
  if (rows.some(r => r.status === "SHORTAGE")) return "SHORTAGE";
  if (rows.some(r => r.status === "SURPLUS")) return "SURPLUS";
  return "BALANCED";
}

function zoneNeedCount(zoneId) {
  return currentForecast.filter(r =>
    r.resident.zone === zoneId && (r.status === "CRITICAL" || r.status === "SHORTAGE")
  ).length;
}

// Hex twins of the CSS status tokens — used for SVG fill/stroke attributes,
// since var() support in presentation attributes is inconsistent across
// renderers. Keep these in sync with the --critical/--shortage/--balanced/
// --surplus custom properties in css/styles.css.
const STATUS_COLOR_HEX = {
  CRITICAL: "#D6402E", SHORTAGE: "#B9790F",
  BALANCED: "#1C8A72", SURPLUS: "#1C7FA6"
};

function renderNetwork() {
  const svg = document.getElementById("networkSvg");
  if (!svg) return;

  const positions = ZONES.map((z, i) => ({ zone: z, pos: zonePosition(i) }));

  const rings = [55, 95, 130].map(r =>
    `<circle class="net-ring" cx="${NETWORK_CENTER.x}" cy="${NETWORK_CENTER.y}" r="${r}"/>`
  ).join("");

  const drawnEdges = new Set();
  const links = [];
  positions.forEach(({ zone }) => {
    (ZONE_ADJACENCY[zone.id] || []).forEach(neighborId => {
      const edgeKey = [zone.id, neighborId].sort().join("|");
      if (drawnEdges.has(edgeKey)) return;
      drawnEdges.add(edgeKey);
      const a = positions.find(p => p.zone.id === zone.id).pos;
      const b = positions.find(p => p.zone.id === neighborId).pos;
      links.push(`<line class="net-link" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`);
    });
  });

  const nodes = positions.map(({ zone, pos }) => {
    if (!zoneHasResidents(zone.id)) {
      return `
        <g class="zone-node zone-node-empty">
          <circle class="node-bg" cx="${pos.x}" cy="${pos.y}" r="28" fill="none" stroke="#82859E" stroke-width="1.5" stroke-dasharray="4 3" opacity="0.6"/>
          <text x="${pos.x}" y="${pos.y + 4}" text-anchor="middle" font-size="9" opacity="0.6">No data</text>
          <text x="${pos.x}" y="${pos.y + 45}" text-anchor="middle" font-size="11" opacity="0.85">${zone.short}</text>
        </g>
      `;
    }
    const status = zoneStatus(zone.id);
    const count = zoneNeedCount(zone.id);
    const color = STATUS_COLOR_HEX[status];
    return `
      <g class="zone-node">
        <circle class="node-bg" cx="${pos.x}" cy="${pos.y}" r="28" fill="${color}" fill-opacity="0.22" stroke="${color}" stroke-width="2"/>
        <text class="node-count" x="${pos.x}" y="${pos.y + 5}" text-anchor="middle" font-size="15">${count}</text>
        <text x="${pos.x}" y="${pos.y + 45}" text-anchor="middle" font-size="11" opacity="0.85">${zone.short}</text>
      </g>
    `;
  }).join("");

  svg.innerHTML = `${rings}${links.join("")}${nodes}
    <text x="${NETWORK_CENTER.x}" y="${NETWORK_CENTER.y - 4}" text-anchor="middle" font-size="9" opacity="0.4" letter-spacing="1" fill="#82859E">${escapeHtml(ISLAND.name.toUpperCase())}</text>`;

  const emptyZones = ZONES.filter(z => !zoneHasResidents(z.id));
  const emptyNote = document.getElementById("networkEmptyNote");
  emptyNote.classList.toggle("hidden", emptyZones.length === 0);
  if (emptyZones.length > 0) {
    emptyNote.textContent = emptyZones.length === 1
      ? `No residents currently in ${emptyZones[0].name}.`
      : `No residents currently in: ${emptyZones.map(z => z.name).join(", ")}.`;
  }
}

/**
 * Renders the 24-Hour Outlook panel: the forecast's own projected peak
 * severity, plus any household/resource pairs that aren't in trouble
 * right now but are projected to tip into CRITICAL before that peak
 * passes, per projectTimeToCritical() in engine.js.
 */
function renderOutlook() {
  const container = document.getElementById("outlookList");
  if (!container) return;

  if (currentHourlyOutlook.length === 0) {
    container.innerHTML = `<div class="ft-empty">24-hour outlook unavailable right now.</div>`;
    return;
  }

  const peak = currentHourlyOutlook.reduce((worst, hour) =>
    SEVERITY_LEVELS.indexOf(hour.severity) > SEVERITY_LEVELS.indexOf(worst.severity) ? hour : worst
  , currentHourlyOutlook[0]);

  const peakLine = peak.severity === "calm"
    ? `<div class="outlook-peak">No worsening conditions expected in the next 24 hours.</div>`
    : `<div class="outlook-peak">Forecast peaks at <strong>${SEVERITY_INFO[peak.severity].label}</strong> in about ${peak.hoursFromNow}h.</div>`;

  const projections = [];
  RESIDENTS.filter(isMine).forEach(resident => {
    RESOURCE_KEYS.forEach(resourceKey => {
      const currentRow = currentForecast.find(r => r.resident.id === resident.id && r.resourceKey === resourceKey);
      if (currentRow && currentRow.status === "CRITICAL") return; // already known — not a new projection
      const etaHours = projectTimeToCritical(resident, resourceKey, currentHourlyOutlook);
      if (etaHours != null) projections.push({ resident, resourceKey, etaHours });
    });
  });
  projections.sort((a, b) => a.etaHours - b.etaHours);

  const list = projections.slice(0, 5).map(p => `
    <div class="activity-row">
      <span class="activity-flow"><strong>${escapeHtml(p.resident.name)}</strong> &mdash; ${p.resourceKey}</span>
      <span class="activity-meta">Projected critical in ~${p.etaHours}h if the forecast holds</span>
    </div>
  `).join("") || `<div class="ft-empty">None of your properties are projected to reach critical in the next 24h.</div>`;

  container.innerHTML = peakLine + list;
}

/**
 * Subscribes to live Supabase changes so every open dashboard — another
 * browser tab, another device, another judge's laptop — reflects a
 * household edit or a confirmed transfer without needing a manual reload.
 * Idempotent: tears down any previous subscriptions first, so calling this
 * again (e.g. after re-entering the dashboard) never stacks up channels.
 */
function subscribeToLiveUpdates() {
  teardownLiveUpdates();

  const residentsChannel = supabaseClient
    .channel("residents-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "residents" }, async () => {
      try {
        RESIDENTS = await fetchResidents();
      } catch (err) {
        console.warn("Live residents update failed to refresh.", err);
        return;
      }
      recompute({ setStep: currentPipelineStep });
      if (activeTab === "profile") renderProfileTab();
    })
    .subscribe();

  const transfersChannel = supabaseClient
    .channel("transfers-live")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "transfers" }, async () => {
      try {
        recentActivity = await fetchRecentTransfers(5);
      } catch (err) {
        console.warn("Live activity update failed to refresh.", err);
        return;
      }
      renderRecentActivity();
    })
    .subscribe();

  liveChannels = [residentsChannel, transfersChannel];
}

function teardownLiveUpdates() {
  liveChannels.forEach(channel => supabaseClient.removeChannel(channel));
  liveChannels = [];
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
  source.innerHTML = `<span class="dot" aria-hidden="true"></span><span>${w.source === "live" ? "Live · Open-Meteo" : "Simulated scenario"}</span>`;

  // Distinct from an intentional manual severity pick or "Simulate Storm"
  // run: only shown when the live fetch itself actually failed, so the
  // demo trigger's own simulated states never get flagged as an outage.
  document.getElementById("weatherFallback").classList.toggle("hidden", !weatherLoadError);

  const summaryEl = document.getElementById("consoleSummary");
  if (residentsLoadError) {
    summaryEl.innerHTML = `<span class="summary-error">Could not load household data — showing an incomplete picture. <button type="button" class="link-btn" id="retryResidentsBtn">Retry</button></span>`;
    document.getElementById("retryResidentsBtn").addEventListener("click", retryLoadResidents);
  } else if (RESIDENTS.length === 0) {
    summaryEl.textContent = "No households on file yet for this community.";
  } else {
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
    summaryEl.innerHTML = summaryBits.join(" &middot; ");
  }

  renderRecommendations();
}

function matchKey(m) {
  return `${m.giver.id}|${m.receiver.id}|${m.resourceKey}`;
}

function residentHours(resident, resourceKey) {
  const row = currentForecast.find(r => r.resident.id === resident.id && r.resourceKey === resourceKey);
  return row ? row.hours : 0;
}

/** Digits-and-plus-only href for a tel: link — dialers handle this better
 *  than a formatted display string, and it sidesteps any attribute-escaping
 *  concerns since the result can only ever contain [0-9+]. */
function telHref(phone) {
  return "tel:" + phone.replace(/[^0-9+]/g, "");
}

/** A resident's phone/address, or an honest "not on file" fallback — used
 *  everywhere a match tells someone who to actually call, since matching
 *  only ever produces a recommendation, never an automatic transfer. */
function contactBlock(resident) {
  const phone = resident.phone
    ? `<a class="rec-contact-phone" href="${telHref(resident.phone)}">${escapeHtml(resident.phone)}</a>`
    : `<span class="rec-contact-missing">No phone on file</span>`;
  const address = resident.address
    ? `<div class="rec-contact-address">${escapeHtml(resident.address)}</div>`
    : `<div class="rec-contact-missing">No address on file</div>`;
  return `${phone}${address}`;
}

function renderRecommendations() {
  const recsList = document.getElementById("recsList");

  if (currentSeverity === "calm") {
    recsList.innerHTML = `<div class="ft-empty">Conditions are calm &mdash; no one needs to be contacted yet. Recommendations appear once a storm watch or worse is in effect.</div>`;
    return;
  }

  // Only matches that actually involve one of MY properties, either as the
  // one short (I need to call the donor) or the one with spare capacity
  // (someone needs to call me / I should reach out) — never a match
  // between two other households that has nothing to do with me.
  const myMatches = currentMatchResult.matches.filter(involvesMe);
  const pending = myMatches.filter(m => !handledMatchKeys.has(matchKey(m)));

  if (pending.length === 0) {
    recsList.innerHTML = myMatches.length
      ? `<div class="ft-empty">All your recommended contacts for this scenario have been handled.</div>`
      : `<div class="ft-empty">No shortages involving your properties at this severity &mdash; you're self-sufficient right now.</div>`;
    return;
  }

  recsList.innerHTML = pending.slice(0, 5).map(m => {
    const key = matchKey(m);
    const giverBefore = residentHours(m.giver, m.resourceKey);
    const receiverBefore = residentHours(m.receiver, m.resourceKey);
    const giverAfter = Math.max(0, Math.round((giverBefore - m.amountHours) * 10) / 10);
    const receiverAfter = Math.round((receiverBefore + m.amountHours) * 10) / 10;

    // Always show the OTHER party's contact info — if I'm the one short,
    // that's the donor I need to call; if I'm the donor, that's the
    // household I should reach out to. Never show my own number back to me.
    const iAmReceiver = isMine(m.receiver);
    const counterparty = iAmReceiver ? m.giver : m.receiver;
    const headline = iAmReceiver
      ? `You need ${formatResourceAmount(m.resourceKey, m.amountHours)} of ${m.resourceKey}.`
      : `<strong>${escapeHtml(m.receiver.name)}</strong> needs ${formatResourceAmount(m.resourceKey, m.amountHours)} of ${m.resourceKey} &mdash; you have spare capacity.`;
    const contactLabel = iAmReceiver
      ? `Call ${escapeHtml(counterparty.name)} to arrange it`
      : `Call ${escapeHtml(counterparty.name)} to offer it`;

    return `
      <div class="rec-card" data-key="${key}">
        <div class="ft-kicker">${m.receiverStatus === "CRITICAL" ? "Critical" : "Shortage"} &middot; ${m.resourceKey}</div>
        <div class="rec-question">${headline}</div>

        <div class="rec-contact">
          <div class="rec-contact-label">${contactLabel}</div>
          ${contactBlock(counterparty)}
        </div>

        <div class="rec-confirm-row">
          <span class="rec-confirm-name">${escapeHtml(m.giver.name)}</span>
          <span class="rec-confirm-change loss">${formatResourceAmount(m.resourceKey, giverBefore)} &rarr; ${formatResourceAmount(m.resourceKey, giverAfter)}</span>
        </div>
        <div class="rec-confirm-row">
          <span class="rec-confirm-name">${escapeHtml(m.receiver.name)}</span>
          <span class="rec-confirm-change gain">${formatResourceAmount(m.resourceKey, receiverBefore)} &rarr; ${formatResourceAmount(m.resourceKey, receiverAfter)}</span>
        </div>

        <div class="rec-actions">
          <button class="rec-btn rec-btn-accept" data-action="contacted">Mark as contacted</button>
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
        handledMatchKeys.add(key);
        if (action === "contacted") logTransfer(match);
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
    const isActive = chip.dataset.severity === currentSeverity;
    chip.classList.toggle("active", isActive);
    chip.setAttribute("aria-pressed", String(isActive));
  });

  document.querySelectorAll(".pv-step").forEach(stepEl => {
    const idx = Number(stepEl.dataset.step);
    stepEl.classList.remove("active", "done");
    stepEl.removeAttribute("aria-current");
    if (idx < activeStepIndex) stepEl.classList.add("done");
    else if (idx === activeStepIndex) {
      stepEl.classList.add("active");
      stepEl.setAttribute("aria-current", "step");
    }
  });

  // Every tile and list on this screen is scoped to MY properties — this is
  // a signed-in user's personal dashboard, not an island-wide admin view,
  // so the pipeline "outcome" it shows has to be the outcome for them.
  const myForecast = currentForecast.filter(r => isMine(r.resident));
  const myMatches = currentMatchResult.matches.filter(involvesMe);
  const myUnresolved = currentMatchResult.unresolved.filter(u => isMine(u.resident));

  document.getElementById("outcomeStrip").innerHTML = `
    <div class="o-tile"><div class="o-value mono">${myMatches.length}</div><div class="o-label">Matched</div></div>
    <div class="o-tile"><div class="o-value mono">${myForecast.filter(r => r.status === "CRITICAL").length}</div><div class="o-label">Critical</div></div>
    <div class="o-tile"><div class="o-value mono">${myUnresolved.length}</div><div class="o-label">Unresolved</div></div>
  `;

  renderMatches(myMatches, myUnresolved);
}

function renderMatches(matches, unresolved) {
  document.getElementById("matchesList").innerHTML = matches.length
    ? matches.map(m => {
      // Same counterparty logic as the Console cards: show whoever I'm NOT,
      // never my own contact info reflected back at me.
      const counterparty = isMine(m.receiver) ? m.giver : m.receiver;
      return `
      <div class="ticket receiver-${m.receiverStatus}">
        <div class="ticket-top">
          <div class="ticket-flow">
            <span class="tf-name">${escapeHtml(m.giver.name)}</span>
            <span class="tf-arrow">&rarr;</span>
            <span class="tf-name">${escapeHtml(m.receiver.name)}</span>
          </div>
          <span class="stamp">${m.resourceKey}</span>
        </div>
        <div class="ticket-perf">
          <div class="ticket-meta">
            <span>${formatResourceAmount(m.resourceKey, m.amountHours)} needed · ${m.receiverStatus.toLowerCase()}</span>
            <span class="priority-tag">P${m.priorityScore}</span>
          </div>
          <div class="ticket-contact">
            <span class="ticket-contact-label">Contact ${escapeHtml(counterparty.name)}:</span>
            ${counterparty.phone
              ? `<a class="ticket-contact-phone" href="${telHref(counterparty.phone)}">${escapeHtml(counterparty.phone)}</a>`
              : `<span class="rec-contact-missing">No phone on file</span>`}
          </div>
        </div>
      </div>
    `;
    }).join("")
    : unresolved.length > 0
      ? `<div class="zone-hint">No matches were possible for your properties at this severity &mdash; your shortage below needs outside aid.</div>`
      : `<div class="zone-hint">No shortages involving your properties at this severity level.</div>`;

  const unresolvedHeading = document.getElementById("unresolvedHeading");
  unresolvedHeading.classList.toggle("hidden", unresolved.length === 0);

  document.getElementById("unresolvedList").innerHTML = unresolved.map(u => `
    <div class="unresolved-ticket">
      <strong>${escapeHtml(u.resident.name)}</strong> &mdash; ${u.status.toLowerCase()} ${u.resourceKey} shortage
      (${formatResourceAmount(u.resourceKey, u.hours)} left, priority ${u.priorityScore}). No island donor has spare capacity.
    </div>
  `).join("");
}

/** Called whenever the storm scenario changes, so stale contacted/dismissed state doesn't carry over. */
function resetRecommendationState() {
  handledMatchKeys.clear();
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
