import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet } from 'jose';
import { authConfigured, authOrigin, isSameOrigin, safeReturnTo, tokenHash, getCurrentUser,
  startLogin, consumeOAuthState, verifyGoogleIdentity, finishLogin, logout, SchoolAccountRequired } from '../lib/auth.ts';

const NOW = 1_800_000_000_000;
const ORIGIN = 'https://laundry.example';
const ENV = { APP_ORIGIN: ORIGIN, GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret' };
let pair, publicJwk, keys;
before(async () => {
  pair = await generateKeyPair('RS256');
  publicJwk = { ...await exportJWK(pair.publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
  keys = createLocalJWKSet({ keys: [publicJwk] });
});

function database(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../drizzle/0001_auth.sql', import.meta.url), 'utf8'));
  t.after(() => sqlite.close());
  function statement(sql, values = []) {
    return {
      bind: (...next) => statement(sql, next),
      first: async () => sqlite.prepare(sql).get(...values) ?? null,
      run: async () => ({ meta: sqlite.prepare(sql).run(...values) }),
      execute: () => sqlite.prepare(sql).run(...values),
    };
  }
  return { sqlite, prepare: statement, batch: async (statements) => {
    sqlite.exec('BEGIN');
    try { const result = statements.map((item) => item.execute()); sqlite.exec('COMMIT'); return result; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
}

function request(path = '/', headers = {}, method = 'GET') {
  return new Request(`${ORIGIN}${path}`, { headers, method });
}

async function identity(overrides = {}, privateKey = pair.privateKey) {
  const claims = { iss: 'https://accounts.google.com', aud: ENV.GOOGLE_CLIENT_ID, sub: 'google-sub-123',
    iat: NOW / 1000, exp: NOW / 1000 + 3600, nonce: 'expected-nonce',
    email: 'student@gachon.ac.kr', email_verified: true, hd: 'gachon.ac.kr', ...overrides };
  for (const [name, value] of Object.entries(claims)) if (value === undefined) delete claims[name];
  return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(privateKey);
}

async function begin(db, returnTo = '/?machine=h3-women-2-w1') {
  const response = await startLogin(request(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`), db, ENV, NOW);
  const location = new URL(response.headers.get('Location'));
  const browserCookie = response.headers.get('Set-Cookie').split(';')[0];
  const callback = request(`/api/auth/callback?state=${location.searchParams.get('state')}&code=test-code`, { Cookie: browserCookie });
  return { response, location, browserCookie, callback };
}

async function seedSession(db, token = 's'.repeat(43), expires = NOW + 1000) {
  db.sqlite.prepare('INSERT INTO tmi_users VALUES (?, ?, ?, ?)').run('google-sub-123', 'student@gachon.ac.kr', NOW, NOW);
  db.sqlite.prepare('INSERT INTO auth_sessions VALUES (?, ?, ?)').run(await tokenHash(token), 'google-sub-123', expires);
  return token;
}

test('운영 origin과 설정 검증 및 변경 요청의 필수 Origin 검사', () => {
  assert.equal(authOrigin(request(), {}), null);
  assert.equal(authConfigured(request(), ENV), true);
  assert.equal(authConfigured(request(), { ...ENV, GOOGLE_CLIENT_SECRET: '' }), false);
  assert.equal(authOrigin(request(), { ...ENV, APP_ORIGIN: 'https://another.example' }), null);
  assert.equal(authOrigin(request(), { ...ENV, APP_ORIGIN: `${ORIGIN}/path` }), null);
  assert.equal(authOrigin(new Request('http://127.0.0.1:5173/'), {}), 'http://127.0.0.1:5173');
  assert.equal(authOrigin(new Request('http://evil.localhost.example/'), {}), null);
  assert.equal(isSameOrigin(request('/', { Origin: ORIGIN }), ENV), true);
  assert.equal(isSameOrigin(request(), ENV), false);
  assert.equal(isSameOrigin(request('/', { Origin: 'null' }), ENV), false);
  assert.equal(isSameOrigin(request('/', { Origin: 'https://attacker.example' }), ENV), false);
});

test('로그인 복귀 URL은 동일 origin의 상대 경로만 허용', () => {
  for (const value of ['https://attacker.example', '//attacker.example', '/\\attacker.example', '/api/auth/login', '/\nattacker.example']) {
    assert.equal(safeReturnTo(value, ORIGIN), '/');
  }
  assert.equal(safeReturnTo('/?machine=h3-women-2-w1#queue', ORIGIN), '/?machine=h3-women-2-w1#queue');
});

test('로그인 시작은 state와 브라우저 토큰을 해시 저장하고 nonce 및 PKCE를 사용', async (t) => {
  const db = database(t);
  const { response, location, browserCookie } = await begin(db);
  assert.equal(response.status, 302);
  assert.equal(location.origin, 'https://accounts.google.com');
  assert.equal(location.searchParams.get('scope'), 'openid email');
  assert.equal(location.searchParams.has('access_type'), false);
  assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
  assert.match(response.headers.get('Set-Cookie'), /HttpOnly; SameSite=Lax; Max-Age=600; Secure/);
  const state = db.sqlite.prepare('SELECT * FROM oauth_states').get();
  assert.equal(state.state_hash, await tokenHash(location.searchParams.get('state')));
  assert.equal(state.browser_hash, await tokenHash(browserCookie.split('=')[1]));
  assert.equal(state.nonce, location.searchParams.get('nonce'));
  assert.equal(location.searchParams.get('code_challenge'), createHash('sha256').update(state.code_verifier).digest('base64url'));
  assert.equal(state.expires_at, NOW + 600000);
});

test('설정이 없는 로그인은 우회 계정 없이 503', async (t) => {
  const db = database(t);
  const response = await startLogin(request('/api/auth/login'), db, {}, NOW);
  assert.equal(response.status, 503);
  assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM oauth_states').get().n, 0);
});

test('OAuth state는 브라우저에 묶이며 원자적으로 한 번만 소모', async (t) => {
  const db = database(t);
  const { callback } = await begin(db);
  assert.equal(await consumeOAuthState(new Request(callback.url, { headers: { Cookie: `tmi_oauth=${'x'.repeat(43)}` } }), db, NOW), null);
  const results = await Promise.all([consumeOAuthState(callback, db, NOW), consumeOAuthState(callback, db, NOW)]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM oauth_states').get().n, 0);
});

test('OAuth state 만료 경계와 쿠키 없는 콜백은 거부', async (t) => {
  const db = database(t);
  const { callback } = await begin(db);
  assert.equal(await consumeOAuthState(new Request(callback.url), db, NOW), null);
  assert.equal(await consumeOAuthState(callback, db, NOW + 600000), null);
});

test('서명 검증을 통과한 두 학교 조직 도메인만 Google sub로 구분', async () => {
  for (const hd of ['gachon.ac.kr', 'gc.gachon.ac.kr']) {
    assert.deepEqual(await verifyGoogleIdentity(await identity({ hd }), ENV.GOOGLE_CLIENT_ID, 'expected-nonce', NOW, keys),
      { id: 'google-sub-123', email: 'student@gachon.ac.kr' });
  }
});

test('이메일 문자열만 학교여도 조직 도메인 또는 검증 여부가 다르면 거부', async () => {
  for (const claims of [{ hd: 'gmail.com' }, { hd: undefined }, { email_verified: false }, { email_verified: 'true' }, { hd: 'GACHON.AC.KR' }]) {
    await assert.rejects(verifyGoogleIdentity(await identity(claims), ENV.GOOGLE_CLIENT_ID, 'expected-nonce', NOW, keys), SchoolAccountRequired);
  }
});

test('nonce, audience, issuer, 만료, 오래된 발행, azp와 서명 변조를 거부', async () => {
  const invalid = [{ nonce: 'other' }, { aud: 'other-client' }, { iss: 'https://attacker.example' },
    { exp: NOW / 1000 }, { iat: NOW / 1000 - 601 }, { iat: NOW / 1000 + 60 }, { azp: 'other-client' }, { sub: '' }, { email: 'malformed' }];
  for (const claims of invalid) await assert.rejects(verifyGoogleIdentity(await identity(claims), ENV.GOOGLE_CLIENT_ID, 'expected-nonce', NOW, keys));
  const attacker = await generateKeyPair('RS256');
  await assert.rejects(verifyGoogleIdentity(await identity({}, attacker.privateKey), ENV.GOOGLE_CLIENT_ID, 'expected-nonce', NOW, keys));
});

test('세션은 저장된 해시로 조회하고 정확한 Google sub만 운영자로 허용', async (t) => {
  const db = database(t);
  const token = await seedSession(db);
  const req = request('/api/auth/me', { Cookie: `tmi_session=${token}` });
  assert.deepEqual(await getCurrentUser(req, db, { ...ENV, ADMIN_GOOGLE_SUBS: 'other, google-sub-123 ' }, NOW),
    { id: 'google-sub-123', email: 'student@gachon.ac.kr', isAdmin: true });
  assert.equal((await getCurrentUser(req, db, { ...ENV, ADMIN_GOOGLE_SUBS: 'student@gachon.ac.kr' }, NOW)).isAdmin, false);
  assert.equal(await getCurrentUser(req, db, ENV, NOW + 1000), null);
  assert.equal(await getCurrentUser(request('/'), db, ENV, NOW), null);
  assert.equal(await getCurrentUser(request('/', { Cookie: `tmi_session=${'z'.repeat(43)}` }), db, ENV, NOW), null);
  assert.equal(db.sqlite.prepare('SELECT token_hash FROM auth_sessions').get().token_hash.includes(token), false);
});

test('로그아웃은 동일 Origin에서만 세션을 삭제하고 쿠키를 만료', async (t) => {
  const db = database(t);
  const token = await seedSession(db, 's'.repeat(43), Date.now() + 10000);
  assert.equal((await logout(request('/api/auth/logout', { Cookie: `tmi_session=${token}` }, 'POST'), db, ENV)).status, 403);
  assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM auth_sessions').get().n, 1);
  const response = await logout(request('/api/auth/logout', { Origin: ORIGIN, Cookie: `tmi_session=${token}` }, 'POST'), db, ENV);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Set-Cookie'), /Max-Age=0; Secure/);
  assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM auth_sessions').get().n, 0);
});

test('전체 콜백은 Google 토큰을 보관하지 않고 세션을 교체하며 재사용을 거부', async (t) => {
  const db = database(t);
  const oldToken = await seedSession(db);
  const { callback } = await begin(db);
  const state = db.sqlite.prepare('SELECT * FROM oauth_states').get();
  const idToken = await identity({ nonce: state.nonce, email: 'updated@gachon.ac.kr' });
  const originalFetch = globalThis.fetch;
  let exchanges = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url) === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [publicJwk] });
    assert.equal(String(url), 'https://oauth2.googleapis.com/token');
    assert.equal(options.body.get('code_verifier'), state.code_verifier);
    assert.equal(options.body.get('client_secret'), ENV.GOOGLE_CLIENT_SECRET);
    exchanges++;
    return Response.json({ id_token: idToken, access_token: 'must-not-persist', refresh_token: 'must-not-persist' });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const fullRequest = new Request(callback.url, { headers: { Cookie: `${callback.headers.get('Cookie')}; tmi_session=${oldToken}` } });
  const response = await finishLogin(fullRequest, db, ENV, () => NOW);
  assert.equal(response.headers.get('Location'), `${ORIGIN}/?machine=h3-women-2-w1`);
  assert.equal(exchanges, 1);
  assert.match(response.headers.get('Set-Cookie'), /tmi_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure/);
  assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM tmi_users').get().n, 1);
  assert.equal(db.sqlite.prepare('SELECT email FROM tmi_users').get().email, 'updated@gachon.ac.kr');
  assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM auth_sessions').get().n, 1);
  assert.equal(db.sqlite.prepare('SELECT token_hash FROM auth_sessions').get().token_hash === await tokenHash(oldToken), false);
  assert.equal(db.sqlite.prepare('SELECT expires_at FROM auth_sessions').get().expires_at, NOW + 30 * 86400000);
  assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM oauth_states').get().n, 0);
  const replay = await finishLogin(fullRequest, db, ENV, () => NOW);
  assert.equal(replay.headers.get('Location'), `${ORIGIN}/?authError=invalid_login`);
  assert.equal(exchanges, 1);
});

test('OAuth 오류 로그는 허용된 코드와 상태만 남기고 토큰 응답 원문을 제외', async (t) => {
  const db = database(t);
  const log = t.mock.method(console, 'error', () => {});
  let failureCode = 'invalid_grant';
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: failureCode, error_description: 'secret-email@example.com private-code private-secret', access_token: 'private-token' }, { status: 400 }));
  for (const expected of ['invalid_grant', null]) {
    failureCode = expected ?? 'private-token-private-code';
    const { callback } = await begin(db);
    const response = await finishLogin(callback, db, ENV, () => NOW);
    assert.equal(response.headers.get('Location'), `${ORIGIN}/?authError=login_failed`);
    assert.deepEqual(log.mock.calls.at(-1).arguments, ['OAuth callback failed', {
      stage: 'token_exchange', errorName: 'Error', tokenStatus: 400, ...(expected ? { oauthError: expected } : {}),
    }]);
  }
});

test('JWT 검증 로그는 claim 값 없이 허용된 claim 이름과 reason만 남김', async (t) => {
  const db = database(t);
  const log = t.mock.method(console, 'error', () => {});
  let idToken;
  t.mock.method(globalThis, 'fetch', async (url) => String(url).endsWith('/certs')
    ? Response.json({ keys: [publicJwk] }) : Response.json({ id_token: idToken }));
  for (const [claims, validationClaim] of [[{ aud: 'wrong-client' }, 'aud'], [{ iat: NOW / 1000 + 1 }, 'iat']]) {
    const { callback } = await begin(db);
    const state = db.sqlite.prepare('SELECT * FROM oauth_states').get();
    idToken = await identity({ nonce: state.nonce, email: 'private-email@gachon.ac.kr', ...claims });
    const response = await finishLogin(callback, db, ENV, () => NOW);
    assert.equal(response.headers.get('Location'), `${ORIGIN}/?authError=login_failed`);
    assert.deepEqual(log.mock.calls.at(-1).arguments, ['OAuth callback failed', {
      stage: 'token_identity', errorName: 'JWTClaimValidationFailed', validationCode: 'ERR_JWT_CLAIM_VALIDATION_FAILED',
      validationClaim, validationReason: 'check_failed', tokenStatus: 200,
    }]);
  }
});

test('세션 저장 오류의 원문과 임의 오류 이름 및 코드는 로그에 포함하지 않음', async (t) => {
  const db = database(t);
  const { callback } = await begin(db);
  const state = db.sqlite.prepare('SELECT * FROM oauth_states').get();
  const idToken = await identity({ nonce: state.nonce });
  const log = t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => String(url).endsWith('/certs')
    ? Response.json({ keys: [publicJwk] }) : Response.json({ id_token: idToken }));
  const brokenDb = { ...db, batch: async () => { throw Object.assign(new Error('private-email@gachon.ac.kr private-token'), { name: 'private-error-name', code: 'private-code' }); } };
  const response = await finishLogin(callback, brokenDb, ENV, () => NOW);
  assert.equal(response.headers.get('Location'), `${ORIGIN}/?authError=login_failed`);
  assert.deepEqual(log.mock.calls[0].arguments, ['OAuth callback failed', { stage: 'session_write', errorName: 'UnknownError', tokenStatus: 200 }]);
});

test('OAuth state 저장소 오류도 민감값 없이 단계를 식별', async (t) => {
  const db = database(t);
  const { callback } = await begin(db);
  const log = t.mock.method(console, 'error', () => {});
  const brokenDb = { ...db, prepare: () => { throw new Error('private SQL and private-email@gachon.ac.kr'); } };
  await assert.rejects(finishLogin(callback, brokenDb, ENV, () => NOW));
  assert.deepEqual(log.mock.calls[0].arguments, ['OAuth callback failed', { stage: 'oauth_state', errorName: 'Error' }]);
});


test('허용되지 않은 claim과 reason 문자열은 로그에서 제외', async (t) => {
  const db = database(t);
  const { callback } = await begin(db);
  const log = t.mock.method(console, 'error', () => {});
  const brokenDb = { ...db, prepare: () => { throw Object.assign(new Error('private error message'), {
    code: 'ERR_JWT_CLAIM_VALIDATION_FAILED', claim: 'private-email@example.com', reason: 'private-token',
  }); } };
  await assert.rejects(finishLogin(callback, brokenDb, ENV, () => NOW));
  assert.deepEqual(log.mock.calls[0].arguments, ['OAuth callback failed', {
    stage: 'oauth_state', errorName: 'Error', validationCode: 'ERR_JWT_CLAIM_VALIDATION_FAILED',
  }]);
});


test('토큰 교환 중 초 경계를 넘어 발급된 JWT를 수신 시각으로 검증하고 세션 시간을 계산', async (t) => {
  const db = database(t);
  const { callback } = await begin(db);
  const state = db.sqlite.prepare('SELECT * FROM oauth_states').get();
  let now = NOW;
  const reads = [];
  const clock = () => { reads.push(now); return now; };
  const log = t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).endsWith('/certs')) return Response.json({ keys: [publicJwk] });
    now += 1500;
    return Response.json({ id_token: await identity({ nonce: state.nonce, iat: Math.floor(now / 1000) }) });
  });
  const response = await finishLogin(callback, db, ENV, clock);
  assert.equal(response.headers.get('Location'), `${ORIGIN}/?machine=h3-women-2-w1`);
  assert.deepEqual(reads, [NOW, NOW + 1500, NOW + 1500]);
  assert.equal(log.mock.callCount(), 0);
  const user = db.sqlite.prepare('SELECT created_at, updated_at FROM tmi_users').get();
  assert.equal(user.created_at, NOW + 1500);
  assert.equal(user.updated_at, NOW + 1500);
  assert.equal(db.sqlite.prepare('SELECT expires_at FROM auth_sessions').get().expires_at, NOW + 1500 + 30 * 86400000);
});

test('토큰 교환 중 만료된 JWT는 이전 콜백 시각으로 통과시키지 않음', async (t) => {
  const db = database(t);
  const { callback } = await begin(db);
  const state = db.sqlite.prepare('SELECT * FROM oauth_states').get();
  let now = NOW;
  const log = t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).endsWith('/certs')) return Response.json({ keys: [publicJwk] });
    now += 1500;
    return Response.json({ id_token: await identity({ nonce: state.nonce, exp: NOW / 1000 + 1 }) });
  });
  const response = await finishLogin(callback, db, ENV, () => now);
  assert.equal(response.headers.get('Location'), `${ORIGIN}/?authError=login_failed`);
  assert.equal(log.mock.calls[0].arguments[1].validationCode, 'ERR_JWT_EXPIRED');
  assert.equal(log.mock.calls[0].arguments[1].validationClaim, 'exp');
  assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM auth_sessions').get().n, 0);
});
