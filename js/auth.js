/*
 * auth.js
 * -------
 * Thin wrapper around Supabase Auth (email + password). Tracks the current
 * user in memory and notifies subscribers (app.js) whenever sign-in state
 * changes, passing along the Supabase event name so the caller can tell a
 * real sign-in/out from a routine background token refresh.
 */

let currentUser = null;
const authChangeHandlers = [];

function onAuthChange(handler) {
  authChangeHandlers.push(handler);
}

function notifyAuthChange(event) {
  authChangeHandlers.forEach(handler => handler(currentUser, event));
}

/**
 * Call once on startup. Resolves once Supabase reports the initial
 * session state (event "INITIAL_SESSION" — guaranteed to fire exactly
 * once right after subscribing), so callers can safely await it and know
 * currentUser + the first routing decision are both settled.
 */
function initAuth() {
  return new Promise(resolve => {
    let settled = false;
    supabaseClient.auth.onAuthStateChange((event, session) => {
      currentUser = session ? session.user : null;
      notifyAuthChange(event);
      if (!settled) { settled = true; resolve(); }
    });
  });
}

async function signUp(email, password) {
  const { error } = await supabaseClient.auth.signUp({ email, password });
  if (error) throw error;
}

async function signIn(email, password) {
  const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

async function signOut() {
  const { error } = await supabaseClient.auth.signOut();
  if (error) throw error;
}
