/*
 * residents-store.js
 * -------------------
 * All reads/writes to the Supabase "residents" table + "resource-photos"
 * storage bucket live here, plus the adapter that maps a database row onto
 * the shape engine.js already expects (engine.js itself is untouched).
 *
 * One row = one property (one island). A household with a vacation home
 * on another island has TWO rows under the same user_id — each is its own
 * independent resource pool for the matching engine (a full solar tank at
 * a vacation home a storm away doesn't help anyone at the primary home),
 * which is exactly how the engine already treats any two residents. Name/
 * household_size/ages are about the people, not the building, so they're
 * duplicated across a household's rows rather than normalized out — a
 * deliberate simplicity tradeoff for this project's scope.
 *
 * Column -> engine field mapping:
 *   water, food        -> resources.water.hours / resources.food.hours.
 *     Onboarding asks for these in DAYS (a real person can answer "about
 *     how many days of water do you have?"); they're converted to hours
 *     once, at save time (onboarding.js), so these columns store hours
 *     directly, same as before.
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
 *   ages                -> vulnerableMembers: count of household members
 *     under CHILD_AGE_THRESHOLD or at/over ELDERLY_AGE_THRESHOLD. A
 *     simple, explainable stand-in for "needs extra care during a storm."
 *   shelter              -> shelterRating (sturdy | moderate | weak)
 *   is_critical + device_type + critical_resource -> specialNeeds:
 *     [{ label, resource }] (this schema tracks one critical dependency per
 *     property; critical_resource says whether it depends on power, water,
 *     or food, defaulting to "power" for rows saved before that column existed)
 */

// ESSENTIAL_DRAW_KW (assumed average draw for essential-only emergency use:
// LED lighting, phone charging, a small fridge cycling) lives in engine.js,
// shared with formatResourceAmount() so the capacity->hours conversion here
// and the hours->kWh display conversion there stay in sync.
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
    zone: row.zone,
    householdSize: row.household_size != null ? row.household_size : 1, // note: `||` would wrongly coerce a valid 0 (vacation home, nobody there) back to 1
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
      ? [{ label: row.device_type, resource: row.critical_resource || "power" }]
      : [],
    photoUrl: row.photo_url
  };
}

/** Every property on the island — public read, no auth required. */
async function fetchResidents() {
  const { data, error } = await supabaseClient
    .from("residents")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data.map(mapResidentRow);
}

/** All of the signed-in user's own property rows (0, 1, or several). */
async function fetchMyProperties(userId) {
  const { data, error } = await supabaseClient
    .from("residents")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data;
}

/** Uploads a photo to the public "resource-photos" bucket, returns its public URL. */
async function uploadResidentPhoto(userId, file) {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const path = `${userId}/${unique}-${file.name}`;
  const { error } = await supabaseClient.storage
    .from("resource-photos")
    .upload(path, file, { upsert: true });
  if (error) throw error;

  const { data } = supabaseClient.storage.from("resource-photos").getPublicUrl(path);
  return data.publicUrl;
}

/**
 * Replaces the signed-in user's entire set of properties with the given
 * list. Onboarding always submits a complete snapshot (every property the
 * wizard walked through), so "delete everything of mine, then insert the
 * new set" is simpler and safer than trying to diff/update individual
 * rows across edits.
 */
async function saveMyProperties(userId, properties) {
  const { error: deleteError } = await supabaseClient
    .from("residents")
    .delete()
    .eq("user_id", userId);
  if (deleteError) throw deleteError;

  const { error: insertError } = await supabaseClient
    .from("residents")
    .insert(properties.map(fields => ({ user_id: userId, ...fields })));
  if (insertError) throw insertError;
}
