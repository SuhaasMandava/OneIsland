/*
 * app.js
 * ------
 * UI wiring for OneIsland. This file owns the DOM: four screens
 * (Console / Zone Network / Storm Mode / Profile) toggled by the bottom
 * tab bar, all reading from the same live state. The actual
 * "intelligence" lives in engine.js — this file calls it and paints the
 * result. Residents come live from Supabase (residents-store.js); auth
 * comes from auth.js.
 */

// ---- Application state ----
let currentSeverity = "calm";
let currentWeather = null;
let currentForecast = [];
let currentMatchResult = { matches: [], unresolved: [] };
let simulationRunning = false;
let activeTab = "console";
let selectedZone = null;
let decisionLogLines = [];
let existingPhotoUrl = null; // the signed-in user's current photo, kept if they don't upload a new one

document.addEventListener("DOMContentLoaded", init);

async function init() {
  wireTabs();
  wireControls();
  wireAuthForms();
  populateZoneOptions();

  await initAuth();
  onAuthChange(() => {
    renderAuthStrip();
    renderProfileTab();
  });
  renderAuthStrip();

  try {
    currentWeather = await fetchLiveWeather();
    currentSeverity = currentWeather.severity;
    log(`Connected to Open-Meteo live forecast for ${ISLAND.name}.`);
  } catch (err) {
    currentWeather = simulatedWeatherFor("calm");
    currentSeverity = "calm";
    log("Live weather unavailable (no connection) — showing simulated calm baseline.");
  }

  try {
    RESIDENTS = await fetchResidents();
    log(`Loaded ${RESIDENTS.length} residents from Supabase.`);
  } catch (err) {
    RESIDENTS = [];
    log("Could not load residents from Supabase — check js/config.js for your publishable key.");
  }

  recompute({ setStep: 0 });
  renderProfileTab();
}

// ------------------------------------------------------------------
// Tab bar
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
// Controls
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
  switchTab("storm");

  const sequence = ["calm", "watch", "warning", "severe"];
  const startIndex = Math.max(0, sequence.indexOf(currentSeverity));

  for (let i = startIndex; i < sequence.length; i++) {
    currentSeverity = sequence[i];
    currentWeather = simulatedWeatherFor(currentSeverity);
    log(`Conditions worsening: ${SEVERITY_INFO[currentSeverity].label} (${currentWeather.description}).`);
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

  log("Simulation complete: critical needs matched first, remaining surplus routed by priority.");
  simulationRunning = false;
  setButtonsDisabled(false);
}

function setButtonsDisabled(disabled) {
  document.getElementById("simulateBtn").disabled = disabled;
  document.getElementById("resetBtn").disabled = disabled;
}

// ------------------------------------------------------------------
// Auth strip (top bar) + Profile screen
// ------------------------------------------------------------------

function renderAuthStrip() {
  const el = document.getElementById("authStrip");
  if (currentUser) {
    el.innerHTML = `
      <span class="as-email">${escapeHtml(currentUser.email)}</span>
      <button class="as-logout" id="logoutBtn" type="button">Log out</button>
    `;
    document.getElementById("logoutBtn").addEventListener("click", async () => {
      try { await signOut(); } catch (err) { console.error(err); }
    });
  } else {
    el.innerHTML = `<button class="as-signin" id="signInLinkBtn" type="button">Sign in to add your resources &rarr;</button>`;
    document.getElementById("signInLinkBtn").addEventListener("click", () => switchTab("profile"));
  }
}

function populateZoneOptions() {
  const select = document.getElementById("fZone");
  if (select.options.length > 0) return; // already populated
  select.innerHTML = ZONES.map(z => `<option value="${z.id}">${z.name}</option>`).join("");
}

/** Shows the sign-up/log-in form when logged out, or the "my listing" form when logged in. */
async function renderProfileTab() {
  const authForms = document.getElementById("authForms");
  const listingForm = document.getElementById("myListingForm");
  const note = document.getElementById("authStatusNote");

  if (!currentUser) {
    authForms.classList.remove("hidden");
    listingForm.classList.add("hidden");
    note.textContent = "Sign up or log in to add your household's resource listing.";
    return;
  }

  authForms.classList.add("hidden");
  listingForm.classList.remove("hidden");
  note.textContent = `Signed in as ${currentUser.email}. This form creates or updates your one resident listing.`;

  try {
    const existing = await fetchMyResident(currentUser.id);
    fillListingForm(existing);
  } catch (err) {
    console.error(err);
  }
}

function fillListingForm(row) {
  document.getElementById("fName").value = row ? row.name : "";
  document.getElementById("fZone").value = row ? row.zone : ZONES[0].id;
  document.getElementById("fWater").value = row ? row.water : 24;
  document.getElementById("fFood").value = row ? row.food : 24;
  document.getElementById("fSolar").value = row ? row.solar_power : 0;
  document.getElementById("fBatteries").value = row ? row.batteries : 0;
  document.getElementById("fShelter").value = row ? row.shelter : "moderate";

  const criticalBox = document.getElementById("fCritical");
  const deviceField = document.getElementById("fDevice");
  criticalBox.checked = row ? row.is_critical : false;
  deviceField.value = row && row.device_type ? row.device_type : "";
  deviceField.classList.toggle("hidden", !criticalBox.checked);

  existingPhotoUrl = row ? row.photo_url : null;
  const preview = document.getElementById("fPhotoPreview");
  if (existingPhotoUrl) {
    preview.classList.remove("hidden");
    preview.innerHTML = `<img src="${existingPhotoUrl}" alt="Current photo">`;
  } else {
    preview.classList.add("hidden");
    preview.innerHTML = "";
  }
}

function wireAuthForms() {
  document.getElementById("fCritical").addEventListener("change", e => {
    document.getElementById("fDevice").classList.toggle("hidden", !e.target.checked);
  });

  document.getElementById("signInBtn").addEventListener("click", () => handleAuthSubmit(signIn));
  document.getElementById("signUpBtn").addEventListener("click", () => handleAuthSubmit(signUp, true));

  document.getElementById("myListingForm").addEventListener("submit", handleListingSubmit);
}

async function handleAuthSubmit(authFn, isSignUp) {
  const email = document.getElementById("authEmail").value.trim();
  const password = document.getElementById("authPassword").value;
  const errorEl = document.getElementById("authError");
  errorEl.classList.add("hidden");

  if (!email || password.length < 6) {
    errorEl.textContent = "Enter an email and a password of at least 6 characters.";
    errorEl.classList.remove("hidden");
    return;
  }

  try {
    await authFn(email, password);
    if (isSignUp) {
      errorEl.classList.remove("hidden");
      errorEl.textContent = "Account created. If email confirmation is enabled on the project, check your inbox before logging in.";
    }
  } catch (err) {
    errorEl.textContent = err.message || "Something went wrong.";
    errorEl.classList.remove("hidden");
  }
}

async function handleListingSubmit(e) {
  e.preventDefault();
  const errorEl = document.getElementById("formError");
  errorEl.classList.add("hidden");
  const submitBtn = e.target.querySelector("button[type=submit]");
  submitBtn.disabled = true;

  try {
    const file = document.getElementById("fPhoto").files[0];
    let photoUrl = existingPhotoUrl;
    if (file) {
      photoUrl = await uploadResidentPhoto(currentUser.id, file);
    }

    const isCritical = document.getElementById("fCritical").checked;
    await saveMyResident(currentUser.id, {
      name: document.getElementById("fName").value.trim(),
      zone: document.getElementById("fZone").value,
      water: Number(document.getElementById("fWater").value),
      food: Number(document.getElementById("fFood").value),
      solar_power: Number(document.getElementById("fSolar").value),
      batteries: Number(document.getElementById("fBatteries").value),
      shelter: document.getElementById("fShelter").value,
      is_critical: isCritical,
      device_type: isCritical ? document.getElementById("fDevice").value.trim() || null : null,
      photo_url: photoUrl
    });

    RESIDENTS = await fetchResidents();
    log(`${currentUser.email} saved their resource listing.`);
    recompute({ setStep: 4 });
    switchTab("console");
  } catch (err) {
    errorEl.textContent = err.message || "Could not save your listing.";
    errorEl.classList.remove("hidden");
  } finally {
    submitBtn.disabled = false;
  }
}

/** Runs the engine for currentSeverity and re-renders every screen. */
function recompute({ setStep }) {
  currentForecast = predictConditions(RESIDENTS, currentSeverity);
  currentMatchResult = runMatching(currentForecast);

  renderTopBar();
  renderConsole();
  renderNetwork();
  renderStormScreen(setStep);

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

  document.getElementById("gaugeRow").innerHTML = `
    <div class="gauge"><div class="g-value mono">${Math.round(w.tempF)}&deg;</div><div class="g-label">Temp</div></div>
    <div class="gauge"><div class="g-value mono">${Math.round(w.windMph)}</div><div class="g-label">Wind mph</div></div>
    <div class="gauge"><div class="g-value mono">${Math.round(w.gustMph)}</div><div class="g-label">Gust mph</div></div>
    <div class="gauge"><div class="g-value mono">${w.precipIn.toFixed(1)}&Prime;</div><div class="g-label">Precip</div></div>
  `;

  const shortages = currentForecast.filter(r => r.status === "CRITICAL" || r.status === "SHORTAGE");
  const criticalNeedMatches = currentMatchResult.matches.filter(m =>
    m.receiver.specialNeeds.some(n => n.resource === m.resourceKey)
  );

  const stats = [
    { value: shortages.length, label: "Shortages", accent: "var(--brass)" },
    { value: criticalNeedMatches.length, label: "Critical protected", accent: "var(--critical)" },
    { value: currentMatchResult.matches.length, label: "Matches made", accent: "var(--balanced)" },
    { value: currentMatchResult.unresolved.length, label: "Outside aid", accent: "var(--shortage)" }
  ];
  document.getElementById("consoleStats").innerHTML = stats.map(s => `
    <div class="readout" style="--readout-accent:${s.accent}">
      <div class="r-value mono">${s.value}</div>
      <div class="r-label">${s.label}</div>
    </div>
  `).join("");

  const featureTicket = document.getElementById("featureTicket");
  const top = currentMatchResult.matches[0];
  if (top) {
    featureTicket.innerHTML = `
      <div class="ft-kicker">Priority ${top.priorityScore} · ${top.resourceKey}</div>
      <div class="ft-flow"><span>${top.giver.name}</span><span class="ft-arrow">&rarr;</span><span>${top.receiver.name}</span></div>
      <div class="ft-reason">${top.reasoning}</div>
    `;
  } else {
    featureTicket.innerHTML = `<div class="ft-empty">No shortages detected at this severity &mdash; every household is self-sufficient.</div>`;
  }

  renderLogTail();
}

function renderLogTail() {
  const el = document.getElementById("logTail");
  const lines = decisionLogLines.slice(-3);
  el.innerHTML = lines.length
    ? lines.map(line => `<div class="lt-line">${line}</div>`).join("")
    : `<div class="lt-line log-empty">Waiting for next event&hellip;</div>`;
}

// ------------------------------------------------------------------
// Zone Network screen
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
    const status = zoneStatus(zone.id);
    const count = zoneNeedCount(zone.id);
    const color = STATUS_COLOR_HEX[status];
    const selected = selectedZone === zone.id ? "selected" : "";
    return `
      <g class="zone-node ${selected}" data-zone="${zone.id}">
        <circle class="node-bg" cx="${pos.x}" cy="${pos.y}" r="28" fill="${color}" fill-opacity="0.22" stroke="${color}"/>
        <text class="node-count" x="${pos.x}" y="${pos.y + 5}" text-anchor="middle" font-size="15">${count}</text>
        <text x="${pos.x}" y="${pos.y + 45}" text-anchor="middle" font-size="11" opacity="0.85">${zone.short}</text>
      </g>
    `;
  }).join("");

  const svg = document.getElementById("networkSvg");
  svg.innerHTML = `${rings}${links.join("")}${nodes}
    <text x="${NETWORK_CENTER.x}" y="${NETWORK_CENTER.y - 4}" text-anchor="middle" font-size="9" opacity="0.4" letter-spacing="1" fill="#82859E">KAILANI</text>`;

  svg.querySelectorAll(".zone-node").forEach(node => {
    node.addEventListener("click", () => {
      const zoneId = node.dataset.zone;
      selectedZone = selectedZone === zoneId ? null : zoneId;
      renderNetwork();
      renderZoneDetail();
    });
  });

  renderZoneDetail();
}

function renderZoneDetail() {
  const wrap = document.getElementById("zoneDetailWrap");

  if (!selectedZone) {
    wrap.innerHTML = `<div class="zone-hint">Tap a zone to inspect households and their resource levels.</div>`;
    return;
  }

  const zone = ZONES.find(z => z.id === selectedZone);
  const residents = RESIDENTS.filter(r => r.zone === selectedZone);

  wrap.innerHTML = `
    <div class="zone-detail">
      <div class="zone-detail-head">
        <h3>${zone.name}</h3>
        ${zone.coastal ? '<span class="zd-coastal">Coastal</span>' : ""}
      </div>
      <div class="zone-detail-body" id="zoneResidentBody"></div>
    </div>
  `;

  const body = document.getElementById("zoneResidentBody");
  residents.forEach(resident => body.appendChild(buildResidentCard(resident)));
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

  const photo = resident.photoUrl
    ? `<img class="resident-photo" src="${resident.photoUrl}" alt="">`
    : "";

  card.innerHTML = `
    <div class="resident-card-head">
      ${photo}
      <div>
        <div class="resident-name">${resident.name}</div>
        <div class="resident-meta">${resident.powerSource} power · ${resident.shelterRating} shelter</div>
      </div>
    </div>
    ${badges.length ? `<div class="badge-row">${badges.join("")}</div>` : ""}
    <div class="resource-rows">${resourceRows}</div>
  `;
  return card;
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

  renderDecisionLog();
  renderMatches();
}

function renderDecisionLog() {
  const el = document.getElementById("decisionLog");
  el.innerHTML = decisionLogLines.length
    ? decisionLogLines.map(line => `<div class="log-line">${line}</div>`).join("")
    : `<div class="log-empty">Waiting for next event&hellip;</div>`;
  el.scrollTop = el.scrollHeight;
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
            <span>${m.amountHours}h transferred · ${m.receiverStatus.toLowerCase()}</span>
            <span class="priority-tag">P${m.priorityScore}</span>
          </div>
          <div class="ticket-reason">${m.reasoning}</div>
        </div>
      </div>
    `).join("")
    : `<div class="zone-hint">No shortages detected yet at this severity level.</div>`;

  const unresolvedHeading = document.getElementById("unresolvedHeading");
  unresolvedHeading.classList.toggle("hidden", unresolved.length === 0);

  document.getElementById("unresolvedList").innerHTML = unresolved.map(u => `
    <div class="unresolved-ticket">
      <strong>${u.resident.name}</strong> &mdash; ${u.status.toLowerCase()} ${u.resourceKey} shortage
      (${u.hours}h left, priority ${u.priorityScore}). No island donor has spare capacity.
    </div>
  `).join("");
}

// ------------------------------------------------------------------
// Decision log helpers (shared by Console tail + Storm full log)
// ------------------------------------------------------------------

function log(message) {
  decisionLogLines.push(escapeHtml(message));
  renderLogTail();
  renderDecisionLog();
}

function clearLog() {
  decisionLogLines = [];
  renderLogTail();
  renderDecisionLog();
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
