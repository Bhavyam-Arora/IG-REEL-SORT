// lib/auth.js — Google sign-in, our own tokens, and api(), the one helper every
// backend call goes through. Loaded into the service worker after
// lib/config.js. The popup and content script never call the backend
// themselves; they message the worker, so everything here runs in one place.
//
// Tokens are never logged: not in a console line, not in an error message.

var AUTH_KEY = "auth"; // chrome.storage.local
var ME_KEY = "me"; // chrome.storage.session
var PLAN_KEY = "lastPlan"; // chrome.storage.local: { plan, at }, see isPro
var ME_TTL_MS = 60 * 1000;
// Refresh a little early rather than spend a request on a certain 401.
var EXPIRY_MARGIN_MS = 30 * 1000;

var SESSION_ENDED = "Your session has ended. Please sign in again.";

function signedOutError(message) {
  var err = new Error(message || SESSION_ENDED);
  err.signedOut = true;
  return err;
}

async function getAuth() {
  var o = await chrome.storage.local.get(AUTH_KEY);
  return o[AUTH_KEY] || null;
}

async function saveTokens(data) {
  if (!data || typeof data.accessToken !== "string" || typeof data.refreshToken !== "string") {
    throw new Error("Sign-in didn't complete. Please try again.");
  }
  var auth = {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    accessExpiresAt: Date.now() + (data.expiresIn || 0) * 1000
  };
  await chrome.storage.local.set({ [AUTH_KEY]: auth });
  return auth;
}

function clearMeCache() {
  return chrome.storage.session.remove(ME_KEY);
}

async function clearAuth() {
  await chrome.storage.local.remove([AUTH_KEY, PLAN_KEY]);
  await clearMeCache();
}

// The raw request. Returns { status, ok, data } for any HTTP answer, and only
// throws when there was no answer at all.
async function send(path, method, body, accessToken) {
  var headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (accessToken) headers.Authorization = "Bearer " + accessToken;

  var res;
  try {
    res = await fetch(API_BASE + path, {
      method: method,
      headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (e) {
    var err = new Error("Couldn't reach Sortcut. Check your connection and try again.");
    err.unreachable = true;
    throw err;
  }
  var data = res.status === 204 ? null : await res.json().catch(function () { return null; });
  return { status: res.status, ok: res.ok, data: data };
}

// Every backend call. Adds the bearer token and, on a 401, refreshes once and
// retries once. { auth: false } is for the auth routes themselves, which carry
// their credential in the body and must never recurse into a refresh.
async function api(path, opts) {
  opts = opts || {};
  var method = opts.method || "GET";
  if (opts.auth === false) return send(path, method, opts.body, null);

  var auth = await getAuth();
  if (!auth) throw signedOutError();

  var refreshed = false;
  if (!(auth.accessExpiresAt > Date.now() + EXPIRY_MARGIN_MS)) {
    auth = await refresh(auth.accessToken);
    refreshed = true;
  }

  var res = await send(path, method, opts.body, auth.accessToken);
  if (res.status !== 401) return res;
  if (refreshed) {
    // A token minted a moment ago was refused: nothing left to try.
    await clearAuth();
    throw signedOutError();
  }

  auth = await refresh(auth.accessToken);
  res = await send(path, method, opts.body, auth.accessToken);
  if (res.status === 401) {
    await clearAuth();
    throw signedOutError();
  }
  return res;
}

// One refresh at a time, shared by every caller. Refresh tokens rotate, and the
// backend treats a second use of the same one as a replay and revokes the whole
// family — so two parallel refreshes would sign the user out.
var refreshing = null;

function refresh(staleAccessToken) {
  if (!refreshing) {
    refreshing = doRefresh(staleAccessToken).finally(function () {
      refreshing = null;
    });
  }
  return refreshing;
}

async function doRefresh(staleAccessToken) {
  var auth = await getAuth();
  if (!auth) throw signedOutError();
  // Someone else refreshed while this caller's request was in flight.
  if (auth.accessToken !== staleAccessToken) return auth;

  // A network failure throws out of send() with the tokens kept: the server
  // never answered, so the refresh token is still unused and still valid.
  var res = await api("/v1/auth/refresh", {
    method: "POST",
    auth: false,
    body: { refreshToken: auth.refreshToken }
  });
  if (!res.ok) {
    await clearAuth();
    // 403 is a suspended account, which deserves its own words.
    throw signedOutError(res.status === 403 && res.data && res.data.error);
  }
  return saveTokens(res.data);
}

// ---- Sign-in ----
// Google hands back a signed ID token directly (response_type id_token), which
// the backend verifies. No authorisation code, so no client secret is needed —
// one couldn't be kept secret in extension code anyway (decisions.md §9).

var signingIn = null;

function signIn() {
  // Two Transcribe clicks while signed out should open one Google window.
  if (!signingIn) {
    signingIn = doSignIn().finally(function () {
      signingIn = null;
    });
  }
  return signingIn;
}

async function doSignIn() {
  var nonce = crypto.randomUUID();
  var url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  url.searchParams.set("response_type", "id_token");
  url.searchParams.set("redirect_uri", chrome.identity.getRedirectURL());
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("prompt", "select_account");

  var redirect;
  try {
    redirect = await chrome.identity.launchWebAuthFlow({ url: url.href, interactive: true });
  } catch (e) {
    // Closing the window lands here too, and is by far the common case.
    throw new Error("Sign-in was cancelled.");
  }

  // The token arrives in the fragment, never the query string.
  var params = new URLSearchParams(new URL(redirect).hash.slice(1));
  var idToken = params.get("id_token");
  if (!idToken) throw new Error("Google didn't complete the sign-in. Please try again.");

  var res = await api("/v1/auth/google", {
    method: "POST",
    auth: false,
    body: { idToken: idToken, nonce: nonce, client: "extension" }
  });
  if (!res.ok) {
    throw new Error((res.data && res.data.error) || "Sign-in failed. Please try again.");
  }
  await clearMeCache();
  await saveTokens(res.data);
}

// Signed out locally whatever the server says: a failed logout call leaves at
// worst an unused refresh token that expires on its own.
async function signOut() {
  // A refresh finishing after the clear would quietly sign the user back in.
  if (refreshing) await refreshing.catch(function () {});
  var auth = await getAuth();
  try {
    if (auth) {
      await api("/v1/auth/logout", {
        method: "POST",
        auth: false,
        body: { refreshToken: auth.refreshToken }
      });
    }
  } catch (e) {
    // Offline or unreachable: clearing below is what matters.
  } finally {
    await clearAuth();
  }
}

// ---- /v1/me ----
// Cached in session storage (memory only, survives the worker restarting) so
// opening and closing the popup doesn't hit the backend every time.
async function getMe() {
  var o = await chrome.storage.session.get(ME_KEY);
  var cached = o[ME_KEY];
  if (cached && Date.now() - cached.at < ME_TTL_MS) return cached.data;

  var res = await api("/v1/me");
  if (!res.ok) {
    var err = new Error((res.data && res.data.error) || "Couldn't load your account.");
    // Our server failing says nothing about the account's plan.
    err.unreachable = res.status >= 500;
    throw err;
  }
  await chrome.storage.session.set({ [ME_KEY]: { at: Date.now(), data: res.data } });
  await chrome.storage.local.set({ [PLAN_KEY]: { plan: res.data && res.data.plan, at: Date.now() } });
  return res.data;
}

// ---- Plan ----
// Free unless /v1/me says Pro. The last answer is kept in local storage so a
// Pro user who goes offline, or meets a Sortcut outage, stays Pro for a day;
// past that, or on any answer that isn't an outage, it's Free. Signing out
// (or a session that can't be refreshed) clears it with the tokens.
var PLAN_GRACE_MS = 24 * 60 * 60 * 1000;
var PRO_PLANS = { pro_monthly: 1, pro_yearly: 1 };

async function currentPlan() {
  if (!(await getAuth())) return "none";
  try {
    return (await getMe()).plan || "none";
  } catch (e) {
    if (e.signedOut || !e.unreachable) return "none";
    var o = await chrome.storage.local.get(PLAN_KEY);
    var last = o[PLAN_KEY];
    var fresh = last && typeof last.at === "number" && Date.now() - last.at < PLAN_GRACE_MS;
    return fresh ? last.plan || "none" : "none";
  }
}

// The one answer to "is this user on Pro?", for every Pro-only feature.
async function isPro() {
  return PRO_PLANS[await currentPlan()] === 1;
}
