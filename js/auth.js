/*
 * auth.js
 * -------
 * Thin wrapper around Supabase Auth (email + password). Tracks the current
 * user in memory and notifies subscribers (app.js) whenever sign-in state
 * changes, so the header and Profile tab can re-render.
 */

let currentUser = null;
const authChangeHandlers = [];

function onAuthChange(handler) {
  authChangeHandlers.push(handler);
}

function notifyAuthChange() {
  authChangeHandlers.forEach(handler => handler(currentUser));
}

/** Call once on startup. Restores any existing session and starts listening. */
async function initAuth() {
  const { data } = await supabaseClient.auth.getSession();
  currentUser = data.session ? data.session.user : null;

  supabaseClient.auth.onAuthStateChange((_event, session) => {
    currentUser = session ? session.user : null;
    notifyAuthChange();
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
