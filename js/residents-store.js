/*
 * residents-store.js
 * -------------------
 * All reads/writes to the Supabase "residents" table + "resource-photos"
 * storage bucket live here, plus the adapter that maps a database row onto
 * the shape engine.js already expects (engine.js itself is untouched).
 *
 * Column -> engine field mapping:
 *   water, food        -> resources.water.hours / resources.food.hours.
 *     Onboarding asks for these in DAYS (a real person can answer "about
 *     how many days of water do you have?"); they're converted to hours
 *     once, at save time (see onboarding.js), so these columns store
 *     hours directly, same as before.
 *   solar_power, batteries -> stored as raw kWh CAPACITY (what onboarding
 *     actually asks: "what's your solar system's capacity?"). Converted
 *     to the engine's "hours of power remaining" here, at read time, by
 *     dividing total capacity by an assumed essential-only draw — see
 *     ESSENTIAL_DRAW_KW below. This keeps the raw, honest fact (kWh
 *     capacity) as the source of truth in the database, and treats
 *     "hours of backup" as a derived estimate for the engine.
 *   solar_power/batteries > 0 -> powerSource "independent", else "grid"
 *     (engine.js only special-cases the literal string "grid" — once a
 *     storm reaches Warning strength, grid residents are assumed to lose
 *     power entirely and fall back to a small device-battery buffer)
 *   zones[0]            -> zone (the engine and Zone Network map only
 *     understand one "home base" per resident; a household can select
 *     multiple islands during onboarding, but only the first is used for
 *     matching/mapping — see the note on `zone` in data.js)
 *   ages                -> vulnerableMembers: count of household members
 *     under CHILD_AGE_THRESHOLD or at/over ELDERLY_AGE_THRESHOLD. A
 *     simple, explainable stand-in for "needs extra care during a storm."
 *   shelter              -> shelterRating (sturdy | moderate | weak)
 *   is_critical + device_type -> specialNeeds: [{ label, resource: "power" }]
 *     (this schema tracks one critical dependency per resident, and
 *     assumes it's power-related — true for every critical case in the demo)
 */

const ESSENTIAL_DRAW_KW = 0.15; // assumed average draw for essential-only emergency use: LED lighting, phone charging, a small fridge cycling
const CHILD_AGE_THRESHOLD = 5;
const ELDERLY_AGE_THRESHOLD = 65;

function mapResidentRow(row) {
  const capacityKwh = Number(row.solar_power || 0) + Number(row.batteries || 0);
  const independentHours = capacityKwh / ESSENTIAL_DRAW_KW;
  const ages = row.ages || [];

  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    zone: (row.zones && row.zones[0]) || null,
    zones: row.zones || [],
    householdSize: row.household_size || 1,
    ages,
    powerSource: independentHours > 0 ? "independent" : "grid",
    resources: {
      water: { hours: Number(row.water) },
      food: { hours: Number(row.food) },
      power: { hours: independentHours }
    },
    shelterRating: row.shelter,
    vulnerableMembers: ages.filter(a => a < CHILD_AGE_THRESHOLD || a >= ELDERLY_AGE_THRESHOLD).length,
    specialNeeds: row.is_critical && row.device_type
      ? [{ label: row.device_type, resource: "power" }]
      : [],
    photoUrl: row.photo_url
  };
}

/** Every resident on the island — public read, no auth required. */
async function fetchResidents() {
  const { data, error } = await supabaseClient
    .from("residents")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data.map(mapResidentRow);
}

/** The signed-in user's own row, if they've completed onboarding yet. */
async function fetchMyResident(userId) {
  const { data, error } = await supabaseClient
    .from("residents")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** Uploads a photo to the public "resource-photos" bucket, returns its public URL. */
async function uploadResidentPhoto(userId, file) {
  const path = `${userId}/${Date.now()}-${file.name}`;
  const { error } = await supabaseClient.storage
    .from("resource-photos")
    .upload(path, file, { upsert: true });
  if (error) throw error;

  const { data } = supabaseClient.storage.from("resource-photos").getPublicUrl(path);
  return data.publicUrl;
}

/** Creates or updates the signed-in user's single resident row. */
async function saveMyResident(userId, fields) {
  const { error } = await supabaseClient
    .from("residents")
    .upsert({ user_id: userId, ...fields }, { onConflict: "user_id" });
  if (error) throw error;
}
