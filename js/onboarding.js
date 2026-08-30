/*
 * onboarding.js
 * -------------
 * The guided, one-question-per-screen setup wizard. Used both for a
 * brand-new user's first setup (right after their first login) and for
 * editing an existing profile later from the Profile tab — same steps,
 * just pre-filled and starting past the welcome screen.
 *
 * A household answers "name" / "how many people" / "ages" ONCE (that's
 * about the people, not a building), then picks every island they have a
 * home on. Each selected island then gets its OWN full set of resource
 * questions — a vacation home on another island is a genuinely separate
 * property with its own solar/battery/water/food/shelter/medical-need
 * situation, not just another label on the same pool of resources. The
 * wizard's step list is therefore built dynamically once the islands are
 * known, repeating the same four resource questions once per property.
 *
 * Everything still lands in the same "residents" table via
 * saveMyProperties() (residents-store.js) and feeds the same unmodified
 * prediction/matching engine — one row per property, each an independent
 * resource pool, exactly like any other two residents on the island.
 *
 * Units shown to the user are real-world and natural (days of water,
 * kWh of solar/battery capacity, ages in years) rather than the engine's
 * abstract "hours remaining" — the conversion happens once, at save time
 * (kWh is instead converted at *read* time, in residents-store.js, since
 * that conversion is a lossy estimate best kept out of the stored fact).
 */

let onboarding = null;

function defaultOnboardingState() {
  return {
    editing: false,
    stepIndex: 0,
    steps: ["welcome", "name", "zones", "household", "ages", "review"], // rebuilt once islands are picked
    name: "",
    zones: [],
    householdSize: 1,
    ages: [30],
    properties: [], // one entry per zone, kept in sync with `zones`
    busy: false
  };
}

function blankProperty(zoneId) {
  return {
    zone: zoneId,
    hasSolar: false, solarKwh: 2,
    hasBattery: false, batteryKwh: 3,
    isCritical: false, deviceType: "",
    waterDays: 3, foodDays: 3, shelter: "moderate",
    photoFile: null, existingPhotoUrl: null
  };
}

/** existingRows: this user's raw residents-table rows (from fetchMyProperties), or []/null for first-time setup. */
function startOnboarding(existingRows) {
  onboarding = defaultOnboardingState();
  const rows = existingRows || [];

  if (rows.length > 0) {
    onboarding.editing = true;
    onboarding.stepIndex = 1; // skip the welcome screen when editing
    const first = rows[0];
    onboarding.name = first.name || "";
    onboarding.householdSize = first.household_size || 1;
    onboarding.ages = first.ages && first.ages.length ? first.ages.slice() : [30];
    onboarding.zones = rows.map(r => r.zone);
    onboarding.properties = rows.map(r => ({
      zone: r.zone,
      hasSolar: Number(r.solar_power) > 0, solarKwh: Number(r.solar_power) || 2,
      hasBattery: Number(r.batteries) > 0, batteryKwh: Number(r.batteries) || 3,
      isCritical: !!r.is_critical, deviceType: r.device_type || "",
      waterDays: r.water != null ? Math.round((r.water / 24) * 10) / 10 : 3,
      foodDays: r.food != null ? Math.round((r.food / 24) * 10) / 10 : 3,
      shelter: r.shelter || "moderate",
      photoFile: null, existingPhotoUrl: r.photo_url || null
    }));
    onboarding.steps = buildStepSequence();
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

  const type = currentStepType();

  if (type === "zones") {
    syncPropertiesToZones();
    onboarding.steps = buildStepSequence();
  }
  if (type === "review") {
    submitOnboarding();
    return;
  }

  onboarding.stepIndex++;
  renderOnboardingStep();
}

/** Builds the full step list: fixed household questions, then four resource
 *  questions repeated per selected island, then a final review. */
function buildStepSequence() {
  const steps = ["welcome", "name", "zones", "household", "ages"];
  onboarding.zones.forEach((_zoneId, i) => {
    steps.push({ id: "solar", zoneIndex: i });
    steps.push({ id: "battery", zoneIndex: i });
    steps.push({ id: "medical", zoneIndex: i });
    steps.push({ id: "basics", zoneIndex: i });
  });
  steps.push("review");
  return steps;
}

/** Keeps `properties` aligned with `zones`: preserves answers already given
 *  for islands still selected, adds a blank entry for newly-added ones, and
 *  drops entries for islands that got deselected. */
function syncPropertiesToZones() {
  onboarding.properties = onboarding.zones.map(zoneId =>
    onboarding.properties.find(p => p.zone === zoneId) || blankProperty(zoneId)
  );
}

function currentStep() { return onboarding.steps[onboarding.stepIndex]; }
function currentStepType() { const s = currentStep(); return typeof s === "string" ? s : s.id; }
function currentStepZoneIndex() { const s = currentStep(); return typeof s === "string" ? null : s.zoneIndex; }
function currentProperty() { return onboarding.properties[currentStepZoneIndex()]; }
function zoneLabelForCurrentStep() {
  const zoneId = onboarding.zones[currentStepZoneIndex()];
  const zone = ZONES.find(z => z.id === zoneId);
  return zone ? zone.name : zoneId;
}
/** A small "Home 2 of 3 · Tanna" orientation line — only shown once a
 *  household has more than one property, so the common single-home case
 *  stays exactly as simple as before. */
function propertyKicker() {
  const total = onboarding.zones.length;
  if (total <= 1) return "";
  return `<div class="onb-kicker">Home ${currentStepZoneIndex() + 1} of ${total} &middot; ${zoneLabelForCurrentStep()}</div>`;
}

// ------------------------------------------------------------------
// Validation — one focused check per step, plain-language messages.
// ------------------------------------------------------------------
function validateOnboardingStep() {
  switch (currentStepType()) {
    case "name":
      return onboarding.name.trim().length > 0
        ? { valid: true } : { valid: false, message: "Let us know what to call your household." };
    case "zones":
      return onboarding.zones.length > 0
        ? { valid: true } : { valid: false, message: "Pick at least one island." };
    case "solar": {
      const p = currentProperty();
      return (!p.hasSolar || p.solarKwh > 0)
        ? { valid: true } : { valid: false, message: "Enter your solar system's capacity, or choose “No”." };
    }
    case "battery": {
      const p = currentProperty();
      return (!p.hasBattery || p.batteryKwh > 0)
        ? { valid: true } : { valid: false, message: "Enter your battery capacity, or choose “No”." };
    }
    case "medical": {
      const p = currentProperty();
      return (!p.isCritical || p.deviceType.trim().length > 0)
        ? { valid: true } : { valid: false, message: "Let us know what kind of equipment." };
    }
    case "basics": {
      const p = currentProperty();
      return (p.waterDays >= 0 && p.foodDays >= 0)
        ? { valid: true } : { valid: false, message: "Enter a valid number of days." };
    }
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
  document.getElementById("onbStepContainer").innerHTML = stepMarkup(currentStepType());
  wireStepInputs(currentStepType());
}

/** Progress dots are collapsed by "section" (each property counts as ONE
 *  dot, not four) so a household with several homes doesn't get an
 *  absurdly long dot row. */
function sectionSequence() {
  const sections = ["welcome", "name", "zones", "household", "ages"];
  const zoneCount = Math.max(onboarding.zones.length, 1);
  for (let i = 0; i < zoneCount; i++) sections.push(`property-${i}`);
  sections.push("review");
  return sections;
}
function sectionForStepIndex(idx) {
  const step = onboarding.steps[idx];
  if (typeof step === "string") return step;
  return `property-${step.zoneIndex}`;
}

function renderOnboardingDots() {
  const sections = sectionSequence();
  const currentIdx = sections.indexOf(sectionForStepIndex(onboarding.stepIndex));
  document.getElementById("onbDots").innerHTML = sections.map((_sec, i) => {
    const cls = i === currentIdx ? "onb-dot active" : i < currentIdx ? "onb-dot done" : "onb-dot";
    return `<span class="${cls}"></span>`;
  }).join("");
}

function renderOnboardingNav() {
  const type = currentStepType();
  const backBtn = document.getElementById("onbBackBtn");
  const nextBtn = document.getElementById("onbNextBtn");

  const floor = onboarding.editing ? 1 : 0;
  backBtn.classList.toggle("hidden", onboarding.stepIndex <= floor);

  nextBtn.textContent = type === "welcome" ? "Get Started" : type === "review" ? "Finish" : "Next";
  nextBtn.disabled = onboarding.busy;
}

function setOnboardingBusy(busy) {
  onboarding.busy = busy;
  document.getElementById("onbNextBtn").disabled = busy;
  document.getElementById("onbNextBtn").textContent = busy ? "Saving…" : (currentStepType() === "review" ? "Finish" : "Next");
}

function stepMarkup(type) {
  switch (type) {
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

function wireStepInputs(type) {
  switch (type) {
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
    <label class="field-label">Which island(s) do you have a home on?</label>
    <p class="onb-hint">Select all that apply — including a vacation or second home. Each one gets its own quick set of questions next.</p>
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

// ---- solar (per property) ----
function solarStepMarkup() {
  const p = currentProperty();
  return propertyKicker() + yesNoStepMarkup({
    question: `Do you have solar power at your home on ${zoneLabelForCurrentStep()}?`,
    yn: "onbSolar", value: p.hasSolar,
    followupLabel: "What's your system's capacity, in kWh?",
    followupHint: "Not sure? A small home system is typically 1–3 kWh.",
    followupId: "onbSolarKwh", followupValue: p.solarKwh
  });
}
function wireSolarStep() {
  const p = currentProperty();
  wireYesNoStep("onbSolar", "onbSolarKwh", v => { p.hasSolar = v; }, v => { p.solarKwh = v; });
}

// ---- battery (per property) ----
function batteryStepMarkup() {
  const p = currentProperty();
  return propertyKicker() + yesNoStepMarkup({
    question: `Do you have battery storage at your home on ${zoneLabelForCurrentStep()}?`,
    yn: "onbBattery", value: p.hasBattery,
    followupLabel: "What's its capacity, in kWh?",
    followupHint: "Not sure? A typical home battery bank is 2–10 kWh.",
    followupId: "onbBatteryKwh", followupValue: p.batteryKwh
  });
}
function wireBatteryStep() {
  const p = currentProperty();
  wireYesNoStep("onbBattery", "onbBatteryKwh", v => { p.hasBattery = v; }, v => { p.batteryKwh = v; });
}

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

// ---- medical (per property) ----
function medicalStepMarkup() {
  const p = currentProperty();
  return `
    ${propertyKicker()}
    <label class="field-label">Does anyone rely on life-saving medical equipment at your home on ${zoneLabelForCurrentStep()}?</label>
    <p class="onb-hint">For example: an oxygen concentrator, dialysis machine, or refrigerated insulin.</p>
    <div class="yn-toggle" id="onbMedicalYN">
      <button type="button" class="yn-btn ${p.isCritical ? "active" : ""}" data-value="yes">Yes</button>
      <button type="button" class="yn-btn ${!p.isCritical ? "active" : ""}" data-value="no">No</button>
    </div>
    <div class="onb-followup ${p.isCritical ? "" : "hidden"}" id="onbMedicalFollowup">
      <label class="field-label">What kind?</label>
      <input type="text" class="field-input" id="onbDeviceType" placeholder="e.g. Oxygen concentrator" value="${escapeAttr(p.deviceType)}">
    </div>`;
}
function wireMedicalStep() {
  const p = currentProperty();
  const ynEl = document.getElementById("onbMedicalYN");
  const followupEl = document.getElementById("onbMedicalFollowup");
  ynEl.querySelectorAll(".yn-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const isYes = btn.dataset.value === "yes";
      p.isCritical = isYes;
      followupEl.classList.toggle("hidden", !isYes);
      ynEl.querySelectorAll(".yn-btn").forEach(b => b.classList.toggle("active", b === btn));
    });
  });
  document.getElementById("onbDeviceType").addEventListener("input", e => { p.deviceType = e.target.value; });
}

// ---- basics: water / food / shelter (per property) ----
function basicsStepMarkup() {
  const p = currentProperty();
  const shelters = ["sturdy", "moderate", "weak"];
  const chips = shelters.map(s => `
    <button type="button" class="chip-toggle ${p.shelter === s ? "active" : ""}" data-shelter="${s}">${s[0].toUpperCase()}${s.slice(1)}</button>
  `).join("");
  return `
    ${propertyKicker()}
    <label class="field-label">About how many days of stored water does your home on ${zoneLabelForCurrentStep()} have?</label>
    <input type="number" class="field-input" id="onbWaterDays" min="0" step="0.5" value="${p.waterDays}">

    <label class="field-label">About how many days of food?</label>
    <input type="number" class="field-input" id="onbFoodDays" min="0" step="0.5" value="${p.foodDays}">

    <label class="field-label">How sturdy is the shelter there?</label>
    <div class="chip-grid">${chips}</div>`;
}
function wireBasicsStep() {
  const p = currentProperty();
  document.getElementById("onbWaterDays").addEventListener("input", e => { p.waterDays = Number(e.target.value) || 0; });
  document.getElementById("onbFoodDays").addEventListener("input", e => { p.foodDays = Number(e.target.value) || 0; });
  document.querySelectorAll(".chip-toggle[data-shelter]").forEach(btn => {
    btn.addEventListener("click", () => {
      p.shelter = btn.dataset.shelter;
      document.querySelectorAll(".chip-toggle[data-shelter]").forEach(b => b.classList.toggle("active", b === btn));
    });
  });
}

// ---- review ----
function reviewStepMarkup() {
  const householdRows = [
    ["Household", onboarding.name],
    ["People", `${onboarding.householdSize} (ages ${onboarding.ages.join(", ")})`]
  ].map(([label, value]) => `<div class="review-row"><span>${label}</span><strong>${escapeHtml(String(value))}</strong></div>`).join("");

  const propertyCards = onboarding.properties.map((p, i) => {
    const zone = ZONES.find(z => z.id === p.zone);
    const rows = [
      ["Solar", p.hasSolar ? `${p.solarKwh} kWh` : "None"],
      ["Battery", p.hasBattery ? `${p.batteryKwh} kWh` : "None"],
      ["Critical need", p.isCritical ? p.deviceType : "None"],
      ["Water", `${p.waterDays} days`],
      ["Food", `${p.foodDays} days`],
      ["Shelter", p.shelter[0].toUpperCase() + p.shelter.slice(1)]
    ].map(([label, value]) => `<div class="review-row"><span>${label}</span><strong>${escapeHtml(String(value))}</strong></div>`).join("");

    const preview = p.existingPhotoUrl
      ? `<div class="photo-preview" id="onbPhotoPreview-${i}"><img src="${p.existingPhotoUrl}" alt=""></div>`
      : `<div class="photo-preview hidden" id="onbPhotoPreview-${i}"></div>`;

    return `
      <div class="property-card">
        <div class="property-card-head">${zone ? zone.name : p.zone}</div>
        <div class="review-list">${rows}</div>
        <label class="field-label">Photo of this property (optional)</label>
        <input type="file" class="field-input" id="onbPhoto-${i}" accept="image/*" capture="environment">
        ${preview}
      </div>`;
  }).join("");

  return `
    <h2>You're all set</h2>
    <div class="review-list">${householdRows}</div>
    ${propertyCards}`;
}
function wireReviewStep() {
  onboarding.properties.forEach((p, i) => {
    document.getElementById(`onbPhoto-${i}`).addEventListener("change", e => {
      const file = e.target.files[0];
      if (!file) return;
      p.photoFile = file;
      const preview = document.getElementById(`onbPhotoPreview-${i}`);
      preview.classList.remove("hidden");
      preview.innerHTML = `<img src="${URL.createObjectURL(file)}" alt="">`;
    });
  });
}

// ------------------------------------------------------------------
// Submit
// ------------------------------------------------------------------
async function submitOnboarding() {
  setOnboardingBusy(true);
  try {
    const propertyPayloads = [];
    for (const p of onboarding.properties) {
      let photoUrl = p.existingPhotoUrl;
      if (p.photoFile) {
        photoUrl = await uploadResidentPhoto(currentUser.id, p.photoFile);
      }
      propertyPayloads.push({
        name: onboarding.name.trim(),
        zone: p.zone,
        household_size: onboarding.householdSize,
        ages: onboarding.ages,
        water: Math.round(p.waterDays * 24 * 10) / 10,
        food: Math.round(p.foodDays * 24 * 10) / 10,
        solar_power: p.hasSolar ? p.solarKwh : 0,
        batteries: p.hasBattery ? p.batteryKwh : 0,
        shelter: p.shelter,
        is_critical: p.isCritical,
        device_type: p.isCritical ? (p.deviceType.trim() || null) : null,
        photo_url: photoUrl
      });
    }

    await saveMyProperties(currentUser.id, propertyPayloads);
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
