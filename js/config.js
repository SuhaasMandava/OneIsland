/*
 * config.js
 * ---------
 * Supabase project connection. Committed to the repo on purpose — this is
 * the "publishable" (anon) key, not a secret. It only ever grants what the
 * Row Level Security policies in supabase/schema.sql allow; it can't read
 * or write anything those policies don't permit, so it's safe client-side.
 *
 * Find it in the Supabase dashboard under Project Settings > API.
 */
const SUPABASE_URL = "https://jvasrcudazwajszohhfh.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_5Flx0T090pPaCDFQFCf3Uw_rQ-7x0Zu";

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
