import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createECDH, randomBytes } from 'node:crypto';
import webPush from 'web-push';
import ece from 'http_ece';
import { allowedPushEndpoint, parsePushSubscription } from '../lib/push-validation.ts';
import { hasPushSubscription, pushConfigured, savePushSubscription, sendPush, sendPushTest } from '../lib/push.ts';

const NOW = 1_800_000_000_000;
const vapid = webPush.generateVAPIDKeys();
const ENV = { APP_ORIGIN: 'https://laundry.example', VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey };
const PAYLOAD = { title: 'TMI 세탁실', body: '빨래를 수거해 주세요.', url: '/queue', tag: 'pickup:run-1' };
const originalFetch = globalThis.fetch;
before(() => { globalThis.fetch = async () => { throw new Error('외부 Push 전송은 테스트에서 금지합니다.'); }; });
after(() => { globalThis.fetch = originalFetch; });

function subscription(endpoint = 'https://fcm.googleapis.com/fcm/send/test-endpoint') {
  const privateKey = createECDH('prime256v1');
  const p256dh = privateKey.generateKeys().toString('base64url');
  const auth = randomBytes(16).toString('base64url');
  return { value: { endpoint, keys: { p256dh, auth } }, privateKey };
}

function database(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(readFileSync(new URL('../drizzle/0001_auth.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../drizzle/0003_push.sql', import.meta.url), 'utf8'));
  for (const id of ['owner', 'other']) sqlite.prepare('INSERT INTO tmi_users VALUES (?, ?, ?, ?)').run(id, `${id}@gachon.ac.kr`, NOW, NOW);
  t.after(() => sqlite.close());
  function statement(sql, values = []) {
    const args = /\?\d+/.test(sql) ? [Object.fromEntries(values.map((value, i) => [String(i + 1), value]))] : values;
    return {
      bind: (...next) => statement(sql, next),
      first: async () => sqlite.prepare(sql).get(...args) ?? null,
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
      run: async () => ({ meta: sqlite.prepare(sql).run(...args) }),
    };
  }
  return { sqlite, prepare: statement };
}

const fetchResets = new WeakSet();
function mockFetch(t, transport) {
  if (!fetchResets.has(t)) {
    const previous = globalThis.fetch;
    t.after(() => { globalThis.fetch = previous; });
    fetchResets.add(t);
  }
  globalThis.fetch = transport;
}

test('Push endpoint는 허용된 제공자의 HTTPS 주소만 통과', () => {
  for (const url of [
    'https://fcm.googleapis.com/fcm/send/token',
    'https://updates.push.services.mozilla.com/wpush/v2/token',
    'https://updates-autopush.push.services.mozilla.com/wpush/v2/token',
    'https://web.push.apple.com/Q123',
  ]) assert.equal(allowedPushEndpoint(url), true, url);
  for (const url of [null, {}, 1, '', 'not-url', 'http://fcm.googleapis.com/path',
    'https://fcm.googleapis.com.attacker.example/path', 'https://fakepush.services.mozilla.com/path',
    'https://push.services.mozilla.com.attacker.example/path', 'https://web.push.apple.com.attacker.example/',
    'https://127.0.0.1/', 'https://[::1]/', 'https://169.254.169.254/', 'https://localhost/',
    'https://fcm.googleapis.com@attacker.example/', 'https://user:password@fcm.googleapis.com/',
    'https://fcm.googleapis.com:444/', 'https://fcm.googleapis.com/path#fragment',
    'https://FCM.GOOGLEAPIS.COM/fcm/send/token', 'https://fcm.googleapis.com:443/fcm/send/token',
    ' https://fcm.googleapis.com/fcm/send/token ', `https://fcm.googleapis.com/${'x'.repeat(2048)}`,
  ]) assert.equal(allowedPushEndpoint(url), false, String(url));
});

test('구독 키의 base64url, 길이와 공개 키 형식을 검증', () => {
  const valid = subscription().value;
  assert.deepEqual(parsePushSubscription(valid), valid);
  for (const value of [null, [], {}, { ...valid, endpoint: 'https://attacker.example/' },
    { ...valid, keys: null }, { ...valid, keys: { ...valid.keys, auth: '' } },
    { ...valid, keys: { ...valid.keys, auth: Buffer.alloc(15).toString('base64url') } },
    { ...valid, keys: { ...valid.keys, auth: '*'.repeat(22) } },
    { ...valid, keys: { ...valid.keys, p256dh: Buffer.alloc(64, 4).toString('base64url') } },
    { ...valid, keys: { ...valid.keys, p256dh: Buffer.alloc(65, 3).toString('base64url') } },
  ]) assert.equal(parsePushSubscription(value), null);
});

test('푸시 설정은 공개 키와 비밀 키와 origin이 모두 필요', () => {
  assert.equal(pushConfigured(ENV), true);
  for (const key of ['APP_ORIGIN', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY']) assert.equal(pushConfigured({ ...ENV, [key]: '' }), false);
});

test('발송 본문은 aes128gcm 암호문이며 수신자 키로 원문을 복원', async () => {
  const receiver = subscription();
  let calls = 0;
  const result = await sendPush(receiver.value, PAYLOAD, ENV, 120.9, async (url, options) => {
    calls++;
    assert.equal(url, receiver.value.endpoint);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    const headers = new Headers(options.headers);
    assert.equal(headers.get('content-encoding'), 'aes128gcm');
    assert.equal(headers.get('ttl'), '120');
    assert.equal(headers.get('urgency'), 'high');
    assert.match(headers.get('authorization'), /^vapid t=/);
    const ciphertext = Buffer.from(options.body);
    assert.equal(ciphertext.includes(Buffer.from(PAYLOAD.body)), false);
    assert.deepEqual(JSON.parse(ece.decrypt(ciphertext, { version: 'aes128gcm', privateKey: receiver.privateKey, authSecret: receiver.value.keys.auth }).toString()), PAYLOAD);
    return new Response(null, { status: 201 });
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { accepted: true, expired: false });
  assert.equal('read' in result, false);
  assert.equal('delivered' in result, false);
});

test('TTL은 1초부터 3600초로 제한', async () => {
  const receiver = subscription().value;
  for (const [ttl, expected] of [[-10, '1'], [0, '1'], [1, '1'], [99999, '3600']]) {
    const result = await sendPush(receiver, PAYLOAD, ENV, ttl, async (_, options) => {
      assert.equal(new Headers(options.headers).get('ttl'), expected);
      return new Response(null, { status: 202 });
    });
    assert.equal(result.accepted, true);
  }
});

test('서비스 접수와 만료를 구분하고 응답 스트림을 정리', async () => {
  const receiver = subscription().value;
  for (const status of [200, 201, 202, 301, 400, 404, 410, 429, 500, 503]) {
    let cancelled = false;
    const result = await sendPush(receiver, PAYLOAD, ENV, 300, async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status }));
    assert.deepEqual(result, { accepted: status === 201 || status === 202, expired: status === 404 || status === 410 });
    assert.equal(cancelled, true);
  }
});

test('잘못된 endpoint, 설정과 키는 외부 전송 전에 차단하고 네트워크 오류는 실패 반환', async () => {
  const valid = subscription().value;
  let calls = 0;
  const transport = async () => { calls++; throw new Error('connection failed'); };
  for (const endpoint of ['https://attacker.example/', 'http://fcm.googleapis.com/', 'https://127.0.0.1/']) {
    assert.deepEqual(await sendPush({ ...valid, endpoint }, PAYLOAD, ENV, 300, transport), { accepted: false, expired: false });
  }
  await sendPush(valid, PAYLOAD, {}, 300, transport);
  await sendPush({ ...valid, keys: { ...valid.keys, p256dh: 'invalid' } }, PAYLOAD, ENV, 300, transport);
  assert.equal(calls, 0);
  assert.deepEqual(await sendPush(valid, PAYLOAD, ENV, 300, transport), { accepted: false, expired: false });
  assert.equal(calls, 1);
});

test('동시 구독 저장은 계정별 5개까지만 허용하고 기존 구독 갱신은 허용', async (t) => {
  const db = database(t);
  const subscriptions = Array.from({ length: 12 }, (_, i) => subscription(`https://fcm.googleapis.com/fcm/send/device-${i}`).value);
  const results = await Promise.all(subscriptions.map((value) => savePushSubscription(db, 'owner', value, NOW)));
  assert.equal(results.filter(Boolean).length, 5);
  assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM push_subscriptions WHERE user_id = ? AND active = 1').get('owner').n, 5);
  const replacement = subscription(subscriptions[0].endpoint).value;
  assert.ok(await savePushSubscription(db, 'owner', replacement, NOW + 1));
  assert.equal(db.sqlite.prepare('SELECT p256dh FROM push_subscriptions WHERE endpoint = ?').get(replacement.endpoint).p256dh, replacement.keys.p256dh);
  assert.equal(await savePushSubscription(db, 'owner', subscriptions[5], NOW), null);
  assert.ok(await savePushSubscription(db, 'other', subscriptions[5], NOW));
});

test('다른 계정의 endpoint는 활성 여부와 관계없이 빼앗을 수 없음', async (t) => {
  const db = database(t);
  const owner = subscription().value;
  await savePushSubscription(db, 'owner', owner, NOW);
  const hijack = subscription(owner.endpoint).value;
  assert.equal(await savePushSubscription(db, 'other', hijack, NOW + 1), null);
  assert.equal(await hasPushSubscription(db, 'other', owner.endpoint), false);
  assert.equal(await hasPushSubscription(db, 'owner', owner.endpoint), true);
  assert.equal(await hasPushSubscription(db, 'owner', 'https://fcm.googleapis.com/another'), false);
  db.sqlite.prepare('UPDATE push_subscriptions SET active = 0 WHERE endpoint = ?').run(owner.endpoint);
  assert.equal(await savePushSubscription(db, 'other', hijack, NOW + 2), null);
  assert.equal(await hasPushSubscription(db, 'owner'), false);
  assert.ok(await savePushSubscription(db, 'owner', owner, NOW + 3));
  const row = db.sqlite.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(owner.endpoint);
  assert.equal(row.user_id, 'owner');
  assert.equal(row.p256dh, owner.keys.p256dh);
});

test('비활성 구독 복구도 5개 제한에 포함하고 해제한 슬롯만 재사용', async (t) => {
  const db = database(t);
  const original = subscription().value;
  await savePushSubscription(db, 'owner', original, NOW);
  db.sqlite.prepare('UPDATE push_subscriptions SET active = 0 WHERE endpoint = ?').run(original.endpoint);
  for (let i = 0; i < 5; i++) await savePushSubscription(db, 'owner', subscription(`https://fcm.googleapis.com/${i}`).value, NOW);
  assert.equal(await savePushSubscription(db, 'owner', original, NOW + 1), null);
  db.sqlite.prepare('UPDATE push_subscriptions SET active = 0 WHERE endpoint = ?').run('https://fcm.googleapis.com/0');
  assert.ok(await savePushSubscription(db, 'owner', original, NOW + 2));
  assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM push_subscriptions WHERE active = 1').get().n, 5);
});

test('알림 시험 발송은 본인의 활성 endpoint만 허용하고 30초간 중복 발송 차단', async (t) => {
  const db = database(t);
  const value = subscription().value;
  await savePushSubscription(db, 'owner', value, NOW);
  let calls = 0;
  mockFetch(t, async () => { calls++; return new Response(null, { status: 201 }); });
  assert.equal(await sendPushTest(db, 'other', value.endpoint, ENV, NOW), null);
  assert.equal(await sendPushTest(db, 'owner', 'https://fcm.googleapis.com/unknown', ENV, NOW), null);
  assert.equal(calls, 0);
  const simultaneous = await Promise.all([sendPushTest(db, 'owner', value.endpoint, ENV, NOW), sendPushTest(db, 'owner', value.endpoint, ENV, NOW)]);
  assert.equal(simultaneous.filter((result) => result === true).length, 1);
  assert.equal(simultaneous.filter((result) => result === null).length, 1);
  assert.equal(calls, 1);
  assert.equal(await sendPushTest(db, 'owner', value.endpoint, ENV, NOW + 29999), null);
  assert.equal(await sendPushTest(db, 'owner', value.endpoint, ENV, NOW + 30001), true);
  assert.equal(calls, 2);
});

test('만료된 endpoint는 비활성화하고 일반 발송 실패는 재시도 가능 상태 유지', async (t) => {
  const db = database(t);
  const value = subscription().value;
  for (const [status, active] of [[404, false], [410, false], [429, true], [503, true]]) {
    await savePushSubscription(db, 'owner', value, NOW);
    db.sqlite.prepare('UPDATE push_subscriptions SET last_test_at = 0').run();
    mockFetch(t, async () => new Response(null, { status }));
    assert.equal(await sendPushTest(db, 'owner', value.endpoint, ENV, NOW), false);
    assert.equal(await hasPushSubscription(db, 'owner', value.endpoint), active);
  }
});

test('전송 중 구독 키가 갱신되면 이전 만료 응답이 새 구독을 비활성화하지 않음', async (t) => {
  const db = database(t);
  const value = subscription().value;
  await savePushSubscription(db, 'owner', value, NOW);
  const replacement = subscription(value.endpoint).value;
  mockFetch(t, async () => {
    await savePushSubscription(db, 'owner', replacement, NOW + 1);
    return new Response(null, { status: 410 });
  });
  assert.equal(await sendPushTest(db, 'owner', value.endpoint, ENV, NOW), false);
  assert.equal(await hasPushSubscription(db, 'owner', value.endpoint), true);
  assert.equal(db.sqlite.prepare('SELECT p256dh FROM push_subscriptions').get().p256dh, replacement.keys.p256dh);
});
