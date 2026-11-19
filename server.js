"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = __dirname;

// Load a local .env without requiring a dependency. Existing process variables win.
try {
  const envFile = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
  for (const line of envFile.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const PORT = Number(process.env.PORT || 3000);
const COARENA_URL = (process.env.COARENA_BASE_URL || "https://coarena.ai/api/v1").replace(/\/+$/, "");
const MODEL = process.env.COARENA_MODEL || "gpt-6-luna";
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_PUBLIC_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || "";
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const UNLIMITED_ACCESS_EMAILS = new Set((process.env.UNLIMITED_ACCESS_EMAILS || "")
  .split(",").map((email) => email.trim().toLowerCase()).filter(Boolean));
const LIPWA_BASE_URL = (process.env.LIPWA_BASE_URL || "https://pay.lipwa.app/api").replace(/\/+$/, "");
const ANSWER_PLANS = Object.freeze({
  pack_50: Object.freeze({ answers: 50, amountKes: 25 }),
  pack_100: Object.freeze({ answers: 100, amountKes: 50 }),
  pack_250: Object.freeze({ answers: 250, amountKes: 125 }),
  pack_500: Object.freeze({ answers: 500, amountKes: 250 }),
  pack_1000: Object.freeze({ answers: 1000, amountKes: 500 }),
});
const MAX_BODY_BYTES = 9 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_IN_FLIGHT = 2;
const RATE_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 12;
const requestTimes = new Map();
let inFlight = 0;

function isConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_PUBLIC_KEY && SUPABASE_SECRET_KEY);
}

function hasUnlimitedAccess(user) {
  const email = typeof user?.email === "string" ? user.email.trim().toLowerCase() : "";
  return Boolean(email && user.email_confirmed_at && UNLIMITED_ACCESS_EMAILS.has(email));
}

async function supabaseAuth(pathname, { method = "GET", body, accessToken } = {}) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1${pathname}`, {
    method,
    headers: {
      apikey: SUPABASE_PUBLIC_KEY,
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.msg || data.message || data.error_description || data.error || "Authentication request failed.");
    err.status = response.status;
    throw err;
  }
  return data;
}

async function supabaseAdmin(pathname, { method = "GET", body, prefer } = {}) {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) throw new Error("Supabase server credentials are not configured.");
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
    method,
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      // New sb_secret keys are API keys, not JWTs. Legacy service_role keys
      // still need a Bearer token for the PostgREST database role.
      ...(!SUPABASE_SECRET_KEY.startsWith("sb_secret_") ? { Authorization: `Bearer ${SUPABASE_SECRET_KEY}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(prefer ? { Prefer: prefer } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.message || data?.hint || "Supabase database request failed.");
  return data;
}

async function supabaseRpc(name, args) {
  return supabaseAdmin(`rpc/${name}`, { method: "POST", body: args });
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    let value = part.slice(index + 1);
    try { value = decodeURIComponent(value); } catch { /* Ignore malformed client cookie bytes. */ }
    return [part.slice(0, index), value];
  }));
}

function setSessionCookies(res, session) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  const accessAge = Math.max(60, Number(session.expires_in || 3600));
  res.setHeader("Set-Cookie", [
    `sh_access=${encodeURIComponent(session.access_token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${accessAge}${secure}`,
    `sh_refresh=${encodeURIComponent(session.refresh_token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${secure}`,
  ]);
}

function clearSessionCookies(res) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", [
    `sh_access=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`,
    `sh_refresh=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`,
  ]);
}

function appendSetCookie(res, cookie) {
  const existing = res.getHeader("Set-Cookie");
  res.setHeader("Set-Cookie", [...(Array.isArray(existing) ? existing : existing ? [existing] : []), cookie]);
}

function clearGoogleVerifierCookie(res) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  appendSetCookie(res, `sh_google_verifier=; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

async function getSession(req, res) {
  if (!isConfigured()) return null;
  const sessionCookies = cookies(req);
  if (sessionCookies.sh_access) {
    try {
      const user = await supabaseAuth("/user", { accessToken: sessionCookies.sh_access });
      return { user, accessToken: sessionCookies.sh_access };
    } catch { /* An expired access token may be refreshed below. */ }
  }
  if (sessionCookies.sh_refresh) {
    try {
      const session = await supabaseAuth("/token?grant_type=refresh_token", { method: "POST", body: { refresh_token: sessionCookies.sh_refresh } });
      setSessionCookies(res, session);
      return { user: session.user, accessToken: session.access_token };
    } catch { clearSessionCookies(res); }
  }
  return null;
}

async function getUser(req, res) {
  return (await getSession(req, res))?.user || null;
}

async function requireUser(req, res) {
  const user = await getUser(req, res);
  if (!user) sendJson(res, 401, { error: "Please sign in to continue." });
  return user;
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on("data", (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        reject(Object.assign(new Error("Request is too large. Please reconnect and try again."), { status: 413 }));
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("Request body must be valid JSON."), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function validateImage(image) {
  if (typeof image !== "string") throw Object.assign(new Error("No screenshot was received. Reconnect the tab and try again."), { status: 400 });
  const match = image.match(/^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/i);
  if (!match) throw Object.assign(new Error("Screenshot format is invalid. Please reconnect the tab and try again."), { status: 400 });
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > 6 * 1024 * 1024) {
    throw Object.assign(new Error("Screenshot is empty or too large. Please reconnect the tab and try again."), { status: 413 });
  }
  return image;
}

async function askCoarena(image, prompt) {
  if (!process.env.COARENA_API_KEY) {
    throw Object.assign(new Error("The server is missing COARENA_API_KEY. Add your key to .env and restart the server."), { status: 503 });
  }

  const guidance = typeof prompt === "string" ? prompt.trim().slice(0, 4000) : "";
  const userText = guidance
    ? `Read the screenshot and answer this request directly. Use visible details as context; if important text is unclear, say what you cannot read rather than guessing.\n\nUser request: ${guidance}`
    : "Read the screenshot and answer the clearest visible question or task. If none is visible, give a one-sentence summary of the screen and say that no explicit question is shown. Do not guess at unreadable text.";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${COARENA_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.COARENA_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.15,
        max_tokens: 1200,
        messages: [{
          role: "system",
          content: "You are ScreenHelper, a careful screen-reading assistant. Start with the direct answer. Use general knowledge to explain visible content when useful, but separate facts from inference and never claim details you cannot see. Keep routine answers concise; use numbered steps for procedures and bullets for a few related points. Format with clean Markdown: short headings only for multi-part answers, bold sparingly, inline code for short commands, and fenced blocks for code. Do not output raw Markdown markers as decoration, avoid tables unless they clearly help, and do not add a long preamble or repeat the user's question.",
        }, {
          role: "user",
          content: [
            { type: "text", text: userText },
            { type: "image_url", image_url: { url: image, detail: "high" } },
          ],
        }],
      }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const providerMessage = data?.error?.message || data?.message;
      if (response.status === 401 || response.status === 403) {
        throw Object.assign(new Error("Coarena rejected the API key. Check COARENA_API_KEY and its inference:write permission."), { status: 502 });
      }
      if (response.status === 429) {
        throw Object.assign(new Error("Coarena is rate-limiting requests. Wait a moment and try again."), { status: 503 });
      }
      throw Object.assign(new Error(providerMessage || `Coarena request failed (${response.status}).`), { status: 502 });
    }
    const answer = data?.choices?.[0]?.message?.content;
    const text = Array.isArray(answer) ? answer.map((part) => part.text || "").join("").trim() : answer?.trim();
    if (!text) throw Object.assign(new Error("Coarena returned an empty answer. Please try again."), { status: 502 });
    return text;
  } catch (error) {
    if (error.name === "AbortError") {
      throw Object.assign(new Error("Coarena took too long to respond. Please try again."), { status: 504 });
    }
    if (error.status) throw error;
    throw Object.assign(new Error("Could not reach Coarena. Check the server's internet connection and try again."), { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}

async function handleAuth(req, res, action) {
  if (!isConfigured()) return sendJson(res, 503, { error: "Authentication is not configured yet. Set the Supabase environment variables." });
  try {
    const body = await readJson(req);
    if (action === "signup") {
      if (typeof body.email !== "string" || typeof body.password !== "string" || body.password.length < 8) {
        return sendJson(res, 400, { error: "Enter a valid email and a password with at least 8 characters." });
      }
      const data = await supabaseAuth("/signup", { method: "POST", body: { email: body.email.trim(), password: body.password } });
      if (data.access_token) setSessionCookies(res, data);
      return sendJson(res, 200, { ok: true, confirmation_required: !data.access_token, email: data.user?.email });
    }
    if (action === "login") {
      if (typeof body.email !== "string" || typeof body.password !== "string") return sendJson(res, 400, { error: "Enter your email and password." });
      const data = await supabaseAuth("/token?grant_type=password", { method: "POST", body: { email: body.email.trim(), password: body.password } });
      setSessionCookies(res, data);
      return sendJson(res, 200, { ok: true, email: data.user?.email });
    }
  } catch (error) {
    return sendJson(res, error.status === 400 || error.status === 422 ? 400 : error.status || 502, { error: error.message });
  }
}

function publicAppUrl() {
  const base = process.env.PUBLIC_BASE_URL;
  if (!base) throw new Error("Set PUBLIC_BASE_URL before using Google sign-in.");
  const url = new URL(base);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new Error("PUBLIC_BASE_URL must use HTTPS outside localhost.");
  }
  return url.origin;
}

function handleGoogleStart(_req, res) {
  if (!isConfigured() || !SUPABASE_URL) return sendJson(res, 503, { error: "Supabase is not configured yet." });
  try {
    const crypto = require("node:crypto");
    const appUrl = publicAppUrl();
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    res.setHeader("Set-Cookie", `sh_google_verifier=${encodeURIComponent(verifier)}; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=300${secure}`);
    const authorizeUrl = new URL(`${SUPABASE_URL}/auth/v1/authorize`);
    authorizeUrl.searchParams.set("provider", "google");
    authorizeUrl.searchParams.set("redirect_to", `${appUrl}/api/auth/google/callback`);
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "s256");
    res.writeHead(302, { Location: authorizeUrl.toString(), "Cache-Control": "no-store" });
    res.end();
  } catch (error) {
    sendJson(res, 503, { error: error.message });
  }
}

async function handleGoogleCallback(req, res) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  const fail = () => {
    clearGoogleVerifierCookie(res);
    res.writeHead(302, { Location: "/?auth_error=google", "Cache-Control": "no-store" });
    res.end();
  };
  try {
    const url = new URL(req.url, "http://localhost");
    const params = cookies(req);
    const code = url.searchParams.get("code");
    const verifier = params.sh_google_verifier;
    if (!code || !verifier || url.searchParams.has("error")) return fail();
    const session = await supabaseAuth("/token?grant_type=pkce", {
      method: "POST",
      body: { auth_code: code, code_verifier: verifier },
    });
    setSessionCookies(res, session);
    appendSetCookie(res, `sh_google_verifier=; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
    res.writeHead(302, { Location: "/", "Cache-Control": "no-store" });
    res.end();
  } catch {
    fail();
  }
}

async function handlePasswordRecoveryRequest(req, res) {
  if (!isConfigured()) return sendJson(res, 503, { error: "Password recovery is not configured yet." });
  let body;
  try { body = await readJson(req); } catch (error) { return sendJson(res, error.status || 400, { error: error.message }); }
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJson(res, 400, { error: "Enter a valid email address." });

  try {
    await supabaseAuth("/recover", {
      method: "POST",
      body: { email },
    });
    return sendJson(res, 200, { ok: true, message: "If an account exists for that email, a reset code has been sent." });
  } catch (error) {
    return sendJson(res, error.status || 502, { error: error.status === 429 ? "Too many reset requests. Wait a little and try again." : "Could not send a reset link. Check your email settings and try again." });
  }
}

async function handlePasswordRecoveryVerify(req, res) {
  let body;
  try { body = await readJson(req); } catch (error) { return sendJson(res, error.status || 400, { error: error.message }); }
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!email || !token) return sendJson(res, 400, { error: "Enter the email address and reset code." });
  if (typeof body.password !== "string" || body.password.length < 8) {
    return sendJson(res, 400, { error: "Choose a password with at least 8 characters." });
  }
  try {
    const session = await supabaseAuth("/verify", { method: "POST", body: { email, token, type: "recovery" } });
    try {
      await supabaseAuth("/user", { method: "PUT", body: { password: body.password }, accessToken: session.access_token });
    } catch (error) {
      return sendJson(res, error.status || 400, { error: `The code was accepted, but the password could not be updated. Request a new code. ${error.message}` });
    }
    return sendJson(res, 200, { ok: true, message: "Your password has been updated. Sign in with your new password." });
  } catch (error) {
    return sendJson(res, error.status || 400, { error: error.message || "That reset code is invalid or expired. Request a new one." });
  }
}

async function handleMe(req, res) {
  if (!isConfigured()) return sendJson(res, 503, { error: "Authentication is not configured yet. Set the Supabase environment variables." });
  const user = await getUser(req, res);
  if (!user) return sendJson(res, 200, { authenticated: false });
  try {
    const status = await supabaseRpc("screenhelper_account_status", { p_user_id: user.id });
    const unlimited = hasUnlimitedAccess(user);
    return sendJson(res, 200, { authenticated: true, email: user.email, usage: {
      ...status, unlimited_access: unlimited, ...(unlimited ? { can_ask: true } : {}),
    } });
  } catch (error) {
    return sendJson(res, 503, { error: `Could not load account details: ${error.message}` });
  }
}

async function handleLogout(req, res) {
  const session = cookies(req);
  if (session.sh_access) {
    try { await supabaseAuth("/logout", { method: "POST", accessToken: session.sh_access }); } catch { /* Clear local session even when upstream logout fails. */ }
  }
  clearSessionCookies(res);
  sendJson(res, 200, { ok: true });
}

async function handleCheckout(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  if (hasUnlimitedAccess(user)) return sendJson(res, 403, { error: "This account already has unlimited access." });
  if (!process.env.LIPWA_API_KEY || !process.env.LIPWA_CHANNEL_ID || !process.env.PUBLIC_BASE_URL) {
    return sendJson(res, 503, { error: "Payments are not configured yet. Set Lipwa API key, channel ID, and public callback URL." });
  }
  let body;
  try { body = await readJson(req); } catch (error) { return sendJson(res, error.status || 400, { error: error.message }); }
  const plan = typeof body.plan_id === "string" ? ANSWER_PLANS[body.plan_id] : null;
  if (!plan) return sendJson(res, 400, { error: "Choose one of the available answer bundles." });
  const phone = typeof body.phone === "string" ? body.phone.replace(/[\s()-]/g, "") : "";
  if (!/^(?:\+?254|0)(?:7|1)\d{8}$/.test(phone)) return sendJson(res, 400, { error: "Enter a valid Kenyan M-Pesa number, for example 0712345678." });

  const paymentId = require("node:crypto").randomUUID();
  try {
    await supabaseAdmin("screenhelper_payments", { method: "POST", prefer: "return=minimal", body: {
      id: paymentId, user_id: user.id, amount_kes: plan.amountKes, answers: plan.answers,
    } });
    const response = await fetch(`${LIPWA_BASE_URL}/payments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.LIPWA_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: plan.amountKes,
        phone_number: phone,
        channel_id: process.env.LIPWA_CHANNEL_ID,
        callback_url: `${process.env.PUBLIC_BASE_URL.replace(/\/+$/, "")}/api/lipwa/webhook`,
        api_ref: `screenhelper:${paymentId}`,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.CheckoutRequestID) throw new Error(data.message || data.ResponseDescription || "Lipwa could not start the payment.");
    await supabaseAdmin(`screenhelper_payments?id=eq.${paymentId}`, { method: "PATCH", prefer: "return=minimal", body: { checkout_id: data.CheckoutRequestID } });
    return sendJson(res, 200, {
      payment_id: paymentId, answers: plan.answers, amount_kes: plan.amountKes,
      message: data.CustomerMessage || `Check your phone and enter your M-Pesa PIN to pay KSh ${plan.amountKes}.`,
    });
  } catch (error) {
    try { await supabaseAdmin(`screenhelper_payments?id=eq.${paymentId}`, { method: "PATCH", prefer: "return=minimal", body: { status: "failed" } }); } catch { /* Best effort cleanup. */ }
    return sendJson(res, 502, { error: `Could not start M-Pesa payment: ${error.message}` });
  }
}

async function handlePaymentStatus(req, res, paymentId) {
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    const payment = await supabaseRpc("screenhelper_payment_status", { p_payment_id: paymentId, p_user_id: user.id });
    if (!payment) return sendJson(res, 404, { error: "Payment not found." });
    const usage = await supabaseRpc("screenhelper_account_status", { p_user_id: user.id });
    return sendJson(res, 200, { ...payment, usage });
  } catch (error) {
    return sendJson(res, 503, { error: `Could not check payment: ${error.message}` });
  }
}

async function handleLipwaWebhook(req, res) {
  if (!process.env.LIPWA_API_KEY) return sendJson(res, 503, { error: "Lipwa payments are not configured." });
  try {
    const callback = await readJson(req);
    const checkoutId = callback.checkout_id;
    if (typeof checkoutId !== "string" || !checkoutId) return sendJson(res, 400, { error: "Missing Lipwa checkout ID." });
    const reference = typeof callback.api_ref === "string" ? callback.api_ref : callback.api_ref?.payment_id ? `screenhelper:${callback.api_ref.payment_id}` : "";
    const referenceMatch = reference.match(/^screenhelper:([0-9a-f-]{36})$/i);
    const rows = await supabaseAdmin(`screenhelper_payments?select=id,checkout_id,amount_kes&checkout_id=eq.${encodeURIComponent(checkoutId)}&limit=1`);
    const payment = rows?.[0] || (referenceMatch ? (await supabaseAdmin(`screenhelper_payments?select=id,checkout_id,amount_kes&id=eq.${referenceMatch[1]}&limit=1`))?.[0] : null);
    if (!payment) return sendJson(res, 404, { error: "Payment reference was not found." });

    // Treat the callback as a notification only; confirm status directly with Lipwa.
    const verifyResponse = await fetch(`${LIPWA_BASE_URL}/status?ref=${encodeURIComponent(checkoutId)}`, {
      headers: { Authorization: `Bearer ${process.env.LIPWA_API_KEY}` },
    });
    const verified = await verifyResponse.json().catch(() => ({}));
    if (!verifyResponse.ok) throw new Error("Could not verify the payment with Lipwa.");
    if (verified.pay_reference !== checkoutId) {
      return sendJson(res, 409, { error: "Lipwa's verified checkout ID does not match this callback." });
    }
    const expectedReference = `screenhelper:${payment.id}`;
    if (verified.api_ref !== expectedReference) {
      return sendJson(res, 409, { error: "Lipwa's verified payment reference does not match this purchase." });
    }
    if (verified.status === "payment.success") {
      const amount = Number(verified.amount ?? callback.amount);
      if (amount !== payment.amount_kes) return sendJson(res, 400, { error: "Payment amount does not match this purchase." });
      const settled = await supabaseRpc("screenhelper_settle_payment", {
        p_payment_id: payment.id,
        p_checkout_id: checkoutId,
        p_amount: amount,
        p_receipt: String(verified.receipt || callback.mpesa_code || ""),
      });
      if (!settled?.settled) return sendJson(res, 409, { error: "Payment could not be matched to this purchase." });
    } else if (verified.status === "payment.failed") {
      await supabaseRpc("screenhelper_fail_payment", { p_payment_id: payment.id, p_checkout_id: checkoutId });
    }
    return sendJson(res, 200, { received: true });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || "Could not process Lipwa callback." });
  }
}

async function handleAsk(req, res) {
  const now = Date.now();
  const client = req.socket.remoteAddress || "unknown";
  const recent = (requestTimes.get(client) || []).filter((time) => now - time < RATE_WINDOW_MS);
  if (recent.length >= MAX_REQUESTS_PER_WINDOW) {
    return sendJson(res, 429, { error: "Too many requests from this connection. Wait a minute and try again." });
  }
  if (inFlight >= MAX_IN_FLIGHT) {
    return sendJson(res, 503, { error: "The AI service is busy. Wait a moment and try again." });
  }
  recent.push(now);
  requestTimes.set(client, recent);
  inFlight += 1;
  if (!req.headers["content-type"]?.includes("application/json")) {
    inFlight -= 1;
    return sendJson(res, 415, { error: "Send the screenshot as JSON." });
  }
  let user;
  let consumed;
  try {
    if (!isConfigured()) throw Object.assign(new Error("Supabase is not configured yet."), { status: 503 });
    user = await getUser(req, res);
    if (!user) return sendJson(res, 401, { error: "Please sign in to continue." });
    const body = await readJson(req);
    const image = validateImage(body.image);
    const unlimited = hasUnlimitedAccess(user);
    consumed = unlimited
      ? { allowed: true, plan: "unlimited" }
      : await supabaseRpc("screenhelper_consume_answer", { p_user_id: user.id });
    if (!consumed?.allowed) {
      const usage = await supabaseRpc("screenhelper_account_status", { p_user_id: user.id });
      return sendJson(res, 402, { error: "Your 2-hour free trial has ended. Purchase a 50-answer bundle to continue.", usage });
    }
    const answer = await askCoarena(image, body.prompt);
    const usage = await supabaseRpc("screenhelper_account_status", { p_user_id: user.id });
    if (unlimited) {
      usage.unlimited_access = true;
      usage.can_ask = true;
    }
    sendJson(res, 200, { answer, model: MODEL, usage });
  } catch (error) {
    if (user && consumed?.allowed && consumed.plan === "paid") {
      try { await supabaseRpc("screenhelper_refund_answer", { p_user_id: user.id, p_plan: consumed.plan }); } catch { /* Preserve the original AI error. */ }
    }
    sendJson(res, error.status || 400, { error: error.message || "The request could not be processed." });
  } finally {
    inFlight -= 1;
    if (requestTimes.size > 5000) {
      for (const [address, times] of requestTimes) {
        if (!times.some((time) => now - time < RATE_WINDOW_MS)) requestTimes.delete(address);
      }
    }
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "POST" && url.pathname === "/api/auth/signup") return void handleAuth(req, res, "signup");
  if (req.method === "POST" && url.pathname === "/api/auth/login") return void handleAuth(req, res, "login");
  if (req.method === "POST" && url.pathname === "/api/auth/logout") return void handleLogout(req, res);
  if (req.method === "GET" && url.pathname === "/api/auth/google") return handleGoogleStart(req, res);
  if (req.method === "GET" && url.pathname === "/api/auth/google/callback") return void handleGoogleCallback(req, res);
  if (req.method === "POST" && url.pathname === "/api/auth/recover") return void handlePasswordRecoveryRequest(req, res);
  if (req.method === "POST" && url.pathname === "/api/auth/recover/verify") return void handlePasswordRecoveryVerify(req, res);
  if (req.method === "GET" && url.pathname === "/api/me") return void handleMe(req, res);
  if (req.method === "POST" && url.pathname === "/api/payments/checkout") return void handleCheckout(req, res);
  const paymentMatch = url.pathname.match(/^\/api\/payments\/([0-9a-f-]{36})$/i);
  if (req.method === "GET" && paymentMatch) return void handlePaymentStatus(req, res, paymentMatch[1]);
  if (req.method === "POST" && url.pathname === "/api/lipwa/webhook") return void handleLipwaWebhook(req, res);
  if (req.method === "POST" && url.pathname === "/api/ask") return void handleAsk(req, res);
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/plans")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
    return fs.createReadStream(path.join(ROOT, "index.html")).pipe(res);
  }
  if (req.method === "GET" && url.pathname === "/health") return sendJson(res, 200, { ok: true, provider: "coarena", model: MODEL, auth_configured: isConfigured(), payments_configured: Boolean(process.env.LIPWA_API_KEY && process.env.LIPWA_CHANNEL_ID && process.env.PUBLIC_BASE_URL) });
  sendJson(res, 404, { error: "Not found." });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`ScreenHelper AI listening on http://localhost:${PORT} (Coarena model: ${MODEL})`);
  if (!process.env.COARENA_API_KEY) console.warn("COARENA_API_KEY is not set. Add it to .env before asking questions.");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
