import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface AuthEnv {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  APP_ORIGIN?: string;
  ADMIN_GOOGLE_SUBS?: string;
}

export interface AuthUser { id: string; email: string; isAdmin: boolean }
interface OAuthState { nonce: string; code_verifier: string; return_to: string }
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const OAUTH_SECONDS = 10 * 60;
const SCHOOL_DOMAINS = new Set(["gachon.ac.kr", "gc.gachon.ac.kr"]);
const GOOGLE_KEYS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

export function authOrigin(request: Request, env: AuthEnv): string | null {
  try {
    const requestUrl = new URL(request.url);
    const origin = new URL(env.APP_ORIGIN || requestUrl.origin);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
    if (!env.APP_ORIGIN && !local) return null;
    if (origin.protocol !== "https:" && !(local && origin.protocol === "http:")) return null;
    if (origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) return null;
    return origin.origin === requestUrl.origin ? origin.origin : null;
  } catch { return null; }
}

export function authConfigured(request: Request, env: AuthEnv): boolean {
  return Boolean(authOrigin(request, env) && env.GOOGLE_CLIENT_ID?.trim() && env.GOOGLE_CLIENT_SECRET?.trim());
}

export function isSameOrigin(request: Request, env: AuthEnv): boolean {
  const origin = authOrigin(request, env);
  return origin !== null && request.headers.get("Origin") === origin;
}

export function safeReturnTo(value: string | null, origin: string): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\\\x00-\x20]/.test(value)) return "/";
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || url.pathname.startsWith("/api/auth")) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return "/"; }
}

function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function tokenHash(token: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readCookie(request: Request, name: string): string | null {
  const value = request.headers.get("Cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

function cookie(name: string, value: string, maxAge: number, origin: string): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${origin.startsWith("https:") ? "; Secure" : ""}`;
}

function noStoreJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  for (const value of cookies) headers.append("Set-Cookie", value);
  return new Response(null, { status: 302, headers });
}

function unavailable(): Response {
  return noStoreJson({ error: "학교 로그인을 준비 중이에요. 운영자가 Google 로그인 설정을 완료해야 이용할 수 있어요." }, 503);
}

export async function getCurrentUser(request: Request, db: D1Database, env: AuthEnv, now = Date.now()): Promise<AuthUser | null> {
  if (!authOrigin(request, env)) return null;
  const token = readCookie(request, "tmi_session");
  if (!token) return null;
  const row = await db.prepare(`SELECT u.id, u.email FROM auth_sessions s
    JOIN tmi_users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`)
    .bind(await tokenHash(token), now).first<{ id: string; email: string }>();
  if (!row) return null;
  const admins = new Set((env.ADMIN_GOOGLE_SUBS || "").split(",").map((sub) => sub.trim()).filter(Boolean));
  return { id: row.id, email: row.email, isAdmin: admins.has(row.id) };
}

export async function startLogin(request: Request, db: D1Database, env: AuthEnv, now = Date.now()): Promise<Response> {
  if (!authConfigured(request, env)) return unavailable();
  const origin = authOrigin(request, env)!;
  const state = randomToken();
  const browser = randomToken();
  const nonce = randomToken();
  const verifier = randomToken();
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  await db.batch([
    db.prepare("DELETE FROM oauth_states WHERE expires_at <= ?").bind(now),
    db.prepare(`INSERT INTO oauth_states (state_hash, browser_hash, nonce, code_verifier, return_to, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)`).bind(await tokenHash(state), await tokenHash(browser), nonce, verifier,
      safeReturnTo(new URL(request.url).searchParams.get("returnTo"), origin), now + OAUTH_SECONDS * 1000),
  ]);
  const authorize = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorize.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!, redirect_uri: `${origin}/api/auth/callback`, response_type: "code",
    scope: "openid email", state, nonce, code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account",
  }).toString();
  return redirect(authorize.href, [cookie("tmi_oauth", browser, OAUTH_SECONDS, origin)]);
}

export async function consumeOAuthState(request: Request, db: D1Database, now = Date.now()): Promise<OAuthState | null> {
  const state = new URL(request.url).searchParams.get("state");
  const browser = readCookie(request, "tmi_oauth");
  if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state) || !browser) return null;
  return db.prepare(`DELETE FROM oauth_states WHERE state_hash = ? AND browser_hash = ? AND expires_at > ?
    RETURNING nonce, code_verifier, return_to`).bind(await tokenHash(state), await tokenHash(browser), now).first<OAuthState>();
}

export class SchoolAccountRequired extends Error {}

export async function verifyGoogleIdentity(idToken: string, clientId: string, nonce: string, now = Date.now(), keys: JWTVerifyGetKey = GOOGLE_KEYS): Promise<{ id: string; email: string }> {
  const { payload } = await jwtVerify(idToken, keys, {
    issuer: ["https://accounts.google.com", "accounts.google.com"], audience: clientId, algorithms: ["RS256"],
    requiredClaims: ["sub", "exp", "iat", "nonce", "email", "email_verified"], currentDate: new Date(now), maxTokenAge: "10 minutes",
  });
  if (payload.nonce !== nonce || (payload.azp !== undefined && payload.azp !== clientId)) throw new Error("Invalid identity claims");
  if (typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 255) throw new Error("Invalid subject");
  if (payload.email_verified !== true || typeof payload.hd !== "string" || !SCHOOL_DOMAINS.has(payload.hd)) throw new SchoolAccountRequired();
  if (typeof payload.email !== "string" || payload.email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(payload.email)) throw new Error("Invalid email");
  return { id: payload.sub, email: payload.email };
}

export async function finishLogin(request: Request, db: D1Database, env: AuthEnv, now = Date.now()): Promise<Response> {
  if (!authConfigured(request, env)) return unavailable();
  const origin = authOrigin(request, env)!;
  const clearOAuth = cookie("tmi_oauth", "", 0, origin);
  const state = await consumeOAuthState(request, db, now);
  const params = new URL(request.url).searchParams;
  if (!state || params.has("error") || !params.get("code")) return redirect(`${origin}/?authError=invalid_login`, [clearOAuth]);
  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: params.get("code")!,
        client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: `${origin}/api/auth/callback`, code_verifier: state.code_verifier }), signal: AbortSignal.timeout(10000),
    });
    if (!tokenResponse.ok) throw new Error("Token exchange failed");
    const tokens = await tokenResponse.json() as { id_token?: unknown };
    if (typeof tokens.id_token !== "string") throw new Error("Missing identity token");
    const user = await verifyGoogleIdentity(tokens.id_token, env.GOOGLE_CLIENT_ID!, state.nonce, now);
    const session = randomToken();
    const previousSession = readCookie(request, "tmi_session");
    const writes = [
      db.prepare(`INSERT INTO tmi_users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET email = excluded.email, updated_at = excluded.updated_at`).bind(user.id, user.email, now, now),
      db.prepare("INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
        .bind(await tokenHash(session), user.id, now + SESSION_SECONDS * 1000),
    ];
    if (previousSession) writes.push(db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").bind(await tokenHash(previousSession)));
    await db.batch(writes);
    return redirect(`${origin}${safeReturnTo(state.return_to, origin)}`, [cookie("tmi_session", session, SESSION_SECONDS, origin), clearOAuth]);
  } catch (error) {
    const reason = error instanceof SchoolAccountRequired ? "school_account_required" : "login_failed";
    return redirect(`${origin}/?authError=${reason}`, [clearOAuth]);
  }
}

export async function currentUserResponse(request: Request, db: D1Database, env: AuthEnv): Promise<Response> {
  return noStoreJson({ configured: authConfigured(request, env), user: await getCurrentUser(request, db, env) });
}

export async function logout(request: Request, db: D1Database, env: AuthEnv): Promise<Response> {
  // Drain the optional browser body before returning from the Worker.
  await request.arrayBuffer();
  if (!isSameOrigin(request, env)) return noStoreJson({ error: "현재 페이지에서 다시 로그아웃해 주세요." }, 403);
  const token = readCookie(request, "tmi_session");
  if (token) await db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").bind(await tokenHash(token)).run();
  const response = noStoreJson({ ok: true });
  response.headers.append("Set-Cookie", cookie("tmi_session", "", 0, authOrigin(request, env)!));
  return response;
}
