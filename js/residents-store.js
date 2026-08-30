/*
 * residents-store.js
 * -------------------
 * All reads/writes to the Supabase "residents" table + "resource-photos"
 * storage bucket live here, plus the adapter that maps a database row onto
 * the shape engine.js already expects (unchanged from before Supabase).
 *
 * Column -> engine field mapping:
 *   water, food             -> resources.water.hours / resources.food.hours
 *   solar_power + batteries -> resources.power.hours (combined independent supply)
 *   solar_power/batteries > 0 -> powerSource "independent", else "grid"
 *     (engine.js only special-cases the literal string "grid" — once a
 *     storm reaches Warning strength, grid residents are assumed to lose
 *     power entirely and fall back to a small device-battery buffer)
 *   shelter                 -> shelterRating (sturdy | moderate | weak)
 *   is_critical + device_type -> specialNeeds: [{ label, resource: "power" }]
 *     (this schema only tracks one critical dependency per resident, and
 *     assumes it's power-related — true for every critical case in the demo)
 *   vulnerableMembers is not tracked in this simplified schema and always
 *   defaults to 0 — that scoring term is inactive until a future column
 *   (e.g. vulnerable_members) is added back.
 */

function mapResidentRow(row) {
  const independentHours = Number(row.solar_power || 0) + Number(row.batteries || 0);
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    zone: row.zone,
    householdSize: 1,
    powerSource: independentHours > 0 ? "independent" : "grid",
    resources: {
      water: { hours: Number(row.water) },
      food: { hours: Number(row.food) },
      power: { hours: independentHours }
    },
    shelterRating: row.shelter,
    vulnerableMembers: 0,
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

/** The signed-in user's own row, if they've created one yet. */
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
