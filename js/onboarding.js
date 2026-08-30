/*
 * onboarding.js
 * -------------
 * The guided, one-question-per-screen setup wizard. Used both for a
 * brand-new user's first setup (right after their first login) and for
 * editing an existing profile later from the Profile tab — same steps,
 * just pre-filled and starting past the welcome screen.
 *
 * This collects the same underlying data the old single-page form did —
 * it just changes HOW the user provides it. Everything still lands in
 * the same "residents" table via saveMyResident() (residents-store.js)
 * and feeds the same unmodified prediction/matching engine.
 *
 * Units shown to the user are real-world and natural (days of water,
 * kWh of solar/battery capacity, ages in years) rather than the engine's
 * abstract "hours remaining" — the conversion happens once, here, at
 * save time (residents-store.js does the symmetric kWh conversion at
 * read time for solar/battery, since that one is a lossy estimate best
 * kept out of the stored fact).
 */

const ONBOARDING_STEPS = [
  "welcome", "name", "zones", "household", "ages",
  "solar", "battery", "medical", "basics", "review"
];

let onboarding = null;

function defaultOnboardingState() {
  return {
    editing: false,
    stepIndex: 0,
    name: "",
    zones: [],
    householdSize: 1,
    ages: [30],
    hasSolar: false, solarKwh: 2,
    hasBattery: false, batteryKwh: 3,
    isCritical: false, deviceType: "",
    waterDays: 3, foodDays: 3, shelter: "moderate",
    photoFile: null, existingPhotoUrl: null,
    busy: false
  };
}

/** existingRow: a raw residents-table row (from fetchMyResident), or null for a first-time setup. */
function startOnboarding(existingRow) {
  onboarding = defaultOnboardingState();

  if (existingRow) {
    onboarding.editing = true;
    onboarding.stepIndex = 1; // skip the welcome screen when editing
    onboarding.name = existingRow.name || "";
    onboarding.zones = existingRow.zones ? existingRow.zones.slice() : [];
    onboarding.householdSize = existingRow.household_size || 1;
    onboarding.ages = existingRow.ages && existingRow.ages.length ? existingRow.ages.slice() : [30];
    onboarding.hasSolar = Number(existingRow.solar_power) > 0;
    onboarding.solarKwh = Number(existingRow.solar_power) || 2;
    onboarding.hasBattery = Number(existingRow.batteries) > 0;
    onboarding.batteryKwh = Number(existingRow.batteries) || 3;
    onboarding.isCritical = !!existingRow.is_critical;
    onboarding.deviceType = existingRow.device_type || "";
    onboarding.waterDays = existingRow.water != null ? Math.round((existingRow.water / 24) * 10) / 10 : 3;
    onboarding.foodDays = existingRow.food != null ? Math.round((existingRow.food / 24) * 10) / 10 : 3;
    onboarding.shelter = existingRow.shelter || "moderate";
    onboarding.existingPhotoUrl = existingRow.photo_url || null;
  }

  setAppMode("onboarding");
  renderOnboardingStep();
}

function wireOnboardingControls() {
  document.getElementById("onbBackBtn").addEventListener("click", onboardingGoBack);
  document.getElementById("onbNextBtn").addEventListener("click", onboardingGoNext);
}

function onboardingGoBack() {
  const floor = onboarding.editing ? 1 : 0;
  if (onboarding.stepIndex <= floor) return;
  onboarding.stepIndex--;
  renderOnboardingStep();
}

function onboardingGoNext() {
  const { valid, message } = validateOnboardingStep();
  if (!valid) {
    showOnboardingError(message);
    return;
  }
  hideOnboardingError();

  if (ONBOARDING_STEPS[onboarding.stepIndex] === "review") {
    submitOnboarding();
    return;
  }
  onboarding.stepIndex++;
  renderOnboardingStep();
}

function currentStepId() {
  return ONBOARDING_STEPS[onboarding.stepIndex];
}

// ------------------------------------------------------------------
// Validation — one focused check per step, plain-language messages.
// ------------------------------------------------------------------
function validateOnboardingStep() {
  switch (currentStepId()) {
    case "name":
      return onboarding.name.trim().length > 0
        ? { valid: true } : { valid: false, message: "Let us know what to call your household." };
    case "zones":
      return onboarding.zones.length > 0
        ? { valid: true } : { valid: false, message: "Pick at least one island." };
    case "solar":
      return (!onboarding.hasSolar || onboarding.solarKwh > 0)
        ? { valid: true } : { valid: false, message: "Enter your solar system's capacity, or choose “No”." };
    case "battery":
      return (!onboarding.hasBattery || onboarding.batteryKwh > 0)
        ? { valid: true } : { valid: false, message: "Enter your battery capacity, or choose “No”." };
    case "medical":
      return (!onboarding.isCritical || onboarding.deviceType.trim().length > 0)
        ? { valid: true } : { valid: false, message: "Let us know what kind of equipment." };
    case "basics":
      return (onboarding.waterDays >= 0 && onboarding.foodDays >= 0)
        ? { valid: true } : { valid: false, message: "Enter a valid number of days." };
    default:
      return { valid: true };
  }
}

function showOnboardingError(message) {
  const el = document.getElementById("onbError");
  el.textContent = message;
  el.classList.remove("hidden");
}
function hideOnboardingError() {
  document.getElementById("onbError").classList.add("hidden");
}

// ------------------------------------------------------------------
// Rendering
// ------------------------------------------------------------------
function renderOnboardingStep() {
  hideOnboardingError();
  renderOnboardingDots();
  renderOnboardingNav();
  document.getElementById("onbStepContainer").innerHTML = stepMarkup(currentStepId());
  wireStepInputs(currentStepId());
}

function renderOnboardingDots() {
  document.getElementById("onbDots").innerHTML = ONBOARDING_STEPS.map((_, i) => {
    const cls = i === onboarding.stepIndex ? "onb-dot active" : i < onboarding.stepIndex ? "onb-dot done" : "onb-dot";
    return `<span class="${cls}"></span>`;
  }).join("");
}

function renderOnboardingNav() {
  const stepId = currentStepId();
  const backBtn = document.getElementById("onbBackBtn");
  const nextBtn = document.getElementById("onbNextBtn");

  const floor = onboarding.editing ? 1 : 0;
  backBtn.classList.toggle("hidden", onboarding.stepIndex <= floor);

  nextBtn.textContent = stepId === "welcome" ? "Get Started" : stepId === "review" ? "Finish" : "Next";
  nextBtn.disabled = onboarding.busy;
}

function setOnboardingBusy(busy) {
  onboarding.busy = busy;
  document.getElementById("onbNextBtn").disabled = busy;
  document.getElementById("onbNextBtn").textContent = busy ? "Saving…" : (currentStepId() === "review" ? "Finish" : "Next");
}

function stepMarkup(stepId) {
  switch (stepId) {
    case "welcome": return welcomeStepMarkup();
    case "name": return nameStepMarkup();
    case "zones": return zonesStepMarkup();
    case "household": return householdStepMarkup();
    case "ages": return agesStepMarkup();
    case "solar": return solarStepMarkup();
    case "battery": return batteryStepMarkup();
    case "medical": return medicalStepMarkup();
    case "basics": return basicsStepMarkup();
    case "review": return reviewStepMarkup();
    default: return "";
  }
}

function wireStepInputs(stepId) {
  switch (stepId) {
    case "name": return wireNameStep();
    case "zones": return wireZonesStep();
    case "household": return wireHouseholdStep();
    case "ages": return wireAgesStep();
    case "solar": return wireSolarStep();
    case "battery": return wireBatteryStep();
    case "medical": return wireMedicalStep();
    case "basics": return wireBasicsStep();
    case "review": return wireReviewStep();
  }
}

// ---- welcome ----
function welcomeStepMarkup() {
  return `
    <div class="onb-welcome">
      <div class="onb-kicker">Let's get you set up</div>
      <h2>A few quick questions</h2>
      <p>This tells OneIsland what your household has — and what it might need — before the next cyclone reaches Vanuatu.</p>
    </div>`;
}

// ---- name ----
function nameStepMarkup() {
  return `
    <label class="field-label">What should we call your household?</label>
    <input type="text" class="field-input" id="onbName" placeholder="e.g. Kalo Family" value="${escapeAttr(onboarding.name)}">`;
}
function wireNameStep() {
  document.getElementById("onbName").addEventListener("input", e => { onboarding.name = e.target.value; });
}

// ---- zones ----
function zonesStepMarkup() {
  const chips = ZONES.map(z => `
    <button type="button" class="chip-toggle ${onboarding.zones.includes(z.id) ? "active" : ""}" data-zone="${z.id}">${z.name}</button>
  `).join("");
  return `
    <label class="field-label">Which island(s) do you live on, or have a house on?</label>
    <p class="onb-hint">Select all that apply.</p>
    <div class="chip-grid">${chips}</div>`;
}
function wireZonesStep() {
  document.querySelectorAll(".chip-toggle[data-zone]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.zone;
      const idx = onboarding.zones.indexOf(id);
      if (idx >= 0) onboarding.zones.splice(idx, 1);
      else onboarding.zones.push(id);
      btn.classList.toggle("active");
    });
  });
}

// ---- household size ----
function householdStepMarkup() {
  return `
    <label class="field-label">How many people live in your household?</label>
    <div class="stepper">
      <button type="button" class="stepper-btn" id="onbSizeMinus">−</button>
      <span class="stepper-value mono" id="onbSizeValue">${onboarding.householdSize}</span>
      <button type="button" class="stepper-btn" id="onbSizePlus">+</button>
    </div>`;
}
function wireHouseholdStep() {
  const valueEl = document.getElementById("onbSizeValue");
  document.getElementById("onbSizeMinus").addEventListener("click", () => {
    if (onboarding.householdSize <= 1) return;
    onboarding.householdSize--;
    onboarding.ages.length = onboarding.householdSize;
    valueEl.textContent = onboarding.householdSize;
  });
  document.getElementById("onbSizePlus").addEventListener("click", () => {
    if (onboarding.householdSize >= 12) return;
    onboarding.householdSize++;
    if (onboarding.ages.length < onboarding.householdSize) onboarding.ages.push(30);
    valueEl.textContent = onboarding.householdSize;
  });
}

// ---- ages ----
function agesStepMarkup() {
  while (onboarding.ages.length < onboarding.householdSize) onboarding.ages.push(30);
  onboarding.ages.length = onboarding.householdSize;

  const fields = onboarding.ages.map((age, i) => `
    <div class="age-field">
      <span class="age-field-label">Person ${i + 1}</span>
      <input type="number" class="field-input onb-age-input" data-index="${i}" min="0" max="110" value="${age}">
    </div>
  `).join("");
  return `
    <label class="field-label">What are their ages?</label>
    <p class="onb-hint">Young children and elderly members are flagged as higher priority during a storm.</p>
    <div class="age-grid">${fields}</div>`;
}
function wireAgesStep() {
  document.querySelectorAll(".onb-age-input").forEach(input => {
    input.addEventListener("input", e => {
      const idx = Number(e.target.dataset.index);
      onboarding.ages[idx] = Math.max(0, Math.min(110, Number(e.target.value) || 0));
    });
  });
}

// ---- solar ----
function solarStepMarkup() { return yesNoStepMarkup({
  question: "Do you have solar power?",
  yn: "onbSolar", value: onboarding.hasSolar,
  followupLabel: "What's your system's capacity, in kWh?",
  followupHint: "Not sure? A small home system is typically 1–3 kWh.",
  followupId: "onbSolarKwh", followupValue: onboarding.solarKwh
}); }
function wireSolarStep() { wireYesNoStep("onbSolar", "onbSolarKwh",
  v => { onboarding.hasSolar = v; }, v => { onboarding.solarKwh = v; }); }

// ---- battery ----
function batteryStepMarkup() { return yesNoStepMarkup({
  question: "Do you have battery storage?",
  yn: "onbBattery", value: onboarding.hasBattery,
  followupLabel: "What's its capacity, in kWh?",
  followupHint: "Not sure? A typical home battery bank is 2–10 kWh.",
  followupId: "onbBatteryKwh", followupValue: onboarding.batteryKwh
}); }
function wireBatteryStep() { wireYesNoStep("onbBattery", "onbBatteryKwh",
  v => { onboarding.hasBattery = v; }, v => { onboarding.batteryKwh = v; }); }

function yesNoStepMarkup({ question, yn, value, followupLabel, followupHint, followupId, followupValue }) {
  return `
    <label class="field-label">${question}</label>
    <div class="yn-toggle" id="${yn}YN">
      <button type="button" class="yn-btn ${value ? "active" : ""}" data-value="yes">Yes</button>
      <button type="button" class="yn-btn ${!value ? "active" : ""}" data-value="no">No</button>
    </div>
    <div class="onb-followup ${value ? "" : "hidden"}" id="${yn}Followup">
      <label class="field-label">${followupLabel}</label>
      <input type="number" class="field-input" id="${followupId}" min="0" step="0.5" value="${followupValue}">
      <p class="onb-hint">${followupHint}</p>
    </div>`;
}
function wireYesNoStep(ynPrefix, followupId, setFlag, setValue) {
  const ynEl = document.getElementById(`${ynPrefix}YN`);
  const followupEl = document.getElementById(`${ynPrefix}Followup`);
  ynEl.querySelectorAll(".yn-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const isYes = btn.dataset.value === "yes";
      setFlag(isYes);
      followupEl.classList.toggle("hidden", !isYes);
      ynEl.querySelectorAll(".yn-btn").forEach(b => b.classList.toggle("active", b === btn));
    });
  });
  document.getElementById(followupId).addEventListener("input", e => setValue(Number(e.target.value) || 0));
}

// ---- medical ----
function medicalStepMarkup() {
  return `
    <label class="field-label">Does anyone in your household depend on life-saving medical equipment?</label>
    <p class="onb-hint">For example: an oxygen concentrator, dialysis machine, or refrigerated insulin.</p>
    <div class="yn-toggle" id="onbMedicalYN">
      <button type="button" class="yn-btn ${onboarding.isCritical ? "active" : ""}" data-value="yes">Yes</button>
      <button type="button" class="yn-btn ${!onboarding.isCritical ? "active" : ""}" data-value="no">No</button>
    </div>
    <div class="onb-followup ${onboarding.isCritical ? "" : "hidden"}" id="onbMedicalFollowup">
      <label class="field-label">What kind?</label>
      <input type="text" class="field-input" id="onbDeviceType" placeholder="e.g. Oxygen concentrator" value="${escapeAttr(onboarding.deviceType)}">
    </div>`;
}
function wireMedicalStep() {
  const ynEl = document.getElementById("onbMedicalYN");
  const followupEl = document.getElementById("onbMedicalFollowup");
  ynEl.querySelectorAll(".yn-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const isYes = btn.dataset.value === "yes";
      onboarding.isCritical = isYes;
      followupEl.classList.toggle("hidden", !isYes);
      ynEl.querySelectorAll(".yn-btn").forEach(b => b.classList.toggle("active", b === btn));
    });
  });
  document.getElementById("onbDeviceType").addEventListener("input", e => { onboarding.deviceType = e.target.value; });
}

// ---- basics: water / food / shelter ----
function basicsStepMarkup() {
  const shelters = ["sturdy", "moderate", "weak"];
  const chips = shelters.map(s => `
    <button type="button" class="chip-toggle ${onboarding.shelter === s ? "active" : ""}" data-shelter="${s}">${s[0].toUpperCase()}${s.slice(1)}</button>
  `).join("");
  return `
    <label class="field-label">About how many days of stored water do you have?</label>
    <input type="number" class="field-input" id="onbWaterDays" min="0" step="0.5" value="${onboarding.waterDays}">

    <label class="field-label">About how many days of food?</label>
    <input type="number" class="field-input" id="onbFoodDays" min="0" step="0.5" value="${onboarding.foodDays}">

    <label class="field-label">How sturdy is your shelter?</label>
    <div class="chip-grid">${chips}</div>`;
}
function wireBasicsStep() {
  document.getElementById("onbWaterDays").addEventListener("input", e => { onboarding.waterDays = Number(e.target.value) || 0; });
  document.getElementById("onbFoodDays").addEventListener("input", e => { onboarding.foodDays = Number(e.target.value) || 0; });
  document.querySelectorAll(".chip-toggle[data-shelter]").forEach(btn => {
    btn.addEventListener("click", () => {
      onboarding.shelter = btn.dataset.shelter;
      document.querySelectorAll(".chip-toggle[data-shelter]").forEach(b => b.classList.toggle("active", b === btn));
    });
  });
}

// ---- review ----
function reviewStepMarkup() {
  const zoneNames = onboarding.zones.map(id => ZONES.find(z => z.id === id).name).join(", ");
  const rows = [
    ["Household", onboarding.name],
    ["Island(s)", zoneNames],
    ["People", `${onboarding.householdSize} (ages ${onboarding.ages.join(", ")})`],
    ["Solar", onboarding.hasSolar ? `${onboarding.solarKwh} kWh` : "None"],
    ["Battery", onboarding.hasBattery ? `${onboarding.batteryKwh} kWh` : "None"],
    ["Critical need", onboarding.isCritical ? onboarding.deviceType : "None"],
    ["Water", `${onboarding.waterDays} days`],
    ["Food", `${onboarding.foodDays} days`],
    ["Shelter", onboarding.shelter[0].toUpperCase() + onboarding.shelter.slice(1)]
  ];
  const reviewRows = rows.map(([label, value]) => `
    <div class="review-row"><span>${label}</span><strong>${escapeHtml(String(value))}</strong></div>
  `).join("");

  const preview = onboarding.existingPhotoUrl
    ? `<div class="photo-preview" id="onbPhotoPreview"><img src="${onboarding.existingPhotoUrl}" alt=""></div>`
    : `<div class="photo-preview hidden" id="onbPhotoPreview"></div>`;

  return `
    <h2>You're all set</h2>
    <div class="review-list">${reviewRows}</div>
    <label class="field-label">Add a photo (optional)</label>
    <input type="file" class="field-input" id="onbPhoto" accept="image/*" capture="environment">
    ${preview}`;
}
function wireReviewStep() {
  document.getElementById("onbPhoto").addEventListener("change", e => {
    const file = e.target.files[0];
    if (!file) return;
    onboarding.photoFile = file;
    const preview = document.getElementById("onbPhotoPreview");
    preview.classList.remove("hidden");
    preview.innerHTML = `<img src="${URL.createObjectURL(file)}" alt="">`;
  });
}

// ------------------------------------------------------------------
// Submit
// ------------------------------------------------------------------
async function submitOnboarding() {
  setOnboardingBusy(true);
  try {
    let photoUrl = onboarding.existingPhotoUrl;
    if (onboarding.photoFile) {
      photoUrl = await uploadResidentPhoto(currentUser.id, onboarding.photoFile);
    }

    await saveMyResident(currentUser.id, {
      name: onboarding.name.trim(),
      zones: onboarding.zones,
      household_size: onboarding.householdSize,
      ages: onboarding.ages,
      water: Math.round(onboarding.waterDays * 24 * 10) / 10,
      food: Math.round(onboarding.foodDays * 24 * 10) / 10,
      solar_power: onboarding.hasSolar ? onboarding.solarKwh : 0,
      batteries: onboarding.hasBattery ? onboarding.batteryKwh : 0,
      shelter: onboarding.shelter,
      is_critical: onboarding.isCritical,
      device_type: onboarding.isCritical ? (onboarding.deviceType.trim() || null) : null,
      photo_url: photoUrl
    });

    await enterDashboard();
  } catch (err) {
    showOnboardingError(err.message || "Could not save your profile. Please try again.");
  } finally {
    setOnboardingBusy(false);
  }
}

function escapeAttr(str) {
  return String(str).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
