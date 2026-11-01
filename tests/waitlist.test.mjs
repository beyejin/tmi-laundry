import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { WAITLIST_LIMIT, WAITLIST_TTL_MS, estimateTurns, hashToken, joinQuery, leaveQuery, parseWaitlistCommand, waitlistSnapshot, expiredCleanupQuery } from '../lib/waitlist.ts';

const LOC = 'h3-women-2';
const NOW = 1_800_000_000_000;

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE waitlist_entry (id TEXT PRIMARY KEY, location_id TEXT NOT NULL, nickname TEXT NOT NULL, owner_hash TEXT NOT NULL, created_at INTEGER NOT NULL)');
  const run = (q) => db.prepare(q.sql).get(Object.fromEntries(q.values.map((value, index) => [String(index + 1), value])));
  return {
    db,
    join: (id, nickname, now, locationId = LOC, ownerHash = `hash-${id}`) => run(joinQuery({ id, locationId, nickname, ownerHash }, now)),
    leave: (id, hash) => run(leaveQuery(id, hash)),
    rows: () => db.prepare('SELECT * FROM waitlist_entry').all(),
  };
}

test('명령 검증: 위치, 별명, 토큰', () => {
  assert.deepEqual(parseWaitlistCommand({ action: 'join', locationId: LOC, nickname: '  301호  ' }), { action: 'join', locationId: LOC, nickname: '301호' });
  for (const bad of [null, [], 'x', {}, { action: 'join' }, { action: 'join', locationId: 'h2-women-2', nickname: 'a' }, { action: 'join', locationId: LOC, nickname: '' }, { action: 'join', locationId: LOC, nickname: '   ' },
    { action: 'join', locationId: LOC, nickname: 'a'.repeat(13) }, { action: 'join', locationId: LOC, nickname: 'a\nb' }, { action: 'join', locationId: LOC, nickname: 5 }, { action: 'other' }]) {
    assert.equal(parseWaitlistCommand(bad), null, JSON.stringify(bad));
  }
  assert.ok(parseWaitlistCommand({ action: 'join', locationId: LOC, nickname: 'a'.repeat(12) }));
  const token = 'x'.repeat(32);
  assert.deepEqual(parseWaitlistCommand({ action: 'leave', id: 'abc-123', token }), { action: 'leave', id: 'abc-123', token });
  for (const bad of [{ action: 'leave', id: 'abc', token: 'short' }, { action: 'leave', id: 'abc', token: 'x'.repeat(129) }, { action: 'leave', id: '', token }, { action: 'leave', id: 'a'.repeat(65), token }, { action: 'leave', id: 'a b', token }, { action: 'leave', token }]) {
    assert.equal(parseWaitlistCommand(bad), null, JSON.stringify(bad));
  }
});

test('위치별 8명까지만 올릴 수 있음', () => {
  const t = setup();
  for (let i = 0; i < WAITLIST_LIMIT; i += 1) assert.equal(t.join(`id${i}`, `이름${i}`, NOW + i)?.id, `id${i}`);
  assert.equal(t.join('overflow', '새사람', NOW + 100), undefined);
  assert.equal(t.join('other', '새사람', NOW + 100, 'h3-women-3')?.id, 'other');
  assert.equal(t.rows().length, WAITLIST_LIMIT + 1);
  t.db.close();
});

test('같은 위치의 중복 별명은 거절하고 다른 위치는 허용', () => {
  const t = setup();
  assert.ok(t.join('a', '301호', NOW));
  assert.equal(t.join('b', '301호', NOW + 1), undefined);
  assert.ok(t.join('c', '301호', NOW + 1, 'h3-women-3'));
  t.db.close();
});

test('만료된 행은 정원과 중복에 포함하지 않고 명단에서 숨김', () => {
  const t = setup();
  for (let i = 0; i < WAITLIST_LIMIT; i += 1) t.join(`old${i}`, `이름${i}`, NOW);
  const later = NOW + WAITLIST_TTL_MS + 1;
  assert.equal(waitlistSnapshot(t.rows(), NOW + WAITLIST_TTL_MS - 1).length, WAITLIST_LIMIT);
  assert.ok(t.join('fresh', '이름0', later));
  const rows = t.rows();
  assert.deepEqual(waitlistSnapshot(rows, later).map((entry) => entry.id), ['fresh']);
  const cleanup = expiredCleanupQuery(later);
  t.db.prepare(cleanup.sql).run(...cleanup.values);
  assert.deepEqual(t.rows().map((row) => row.id), ['fresh']);
  t.db.close();
});

test('빠지기는 올바른 소유자 해시일 때만 가능', async () => {
  const t = setup();
  const hash = await hashToken('내토큰'.repeat(6));
  t.join('a', '301호', NOW, LOC, hash);
  assert.equal(t.leave('a', await hashToken('다른토큰')), undefined);
  assert.equal(t.rows().length, 1);
  assert.equal(t.leave('missing', hash), undefined);
  assert.equal(t.leave('a', hash)?.id, 'a');
  assert.equal(t.rows().length, 0);
  t.db.close();
});

test('스냅샷은 소유자 해시를 노출하지 않고 등록 순서대로 정렬', () => {
  const rows = [
    { id: 'b', location_id: LOC, nickname: '둘', owner_hash: 'secret', created_at: NOW + 5 },
    { id: 'z', location_id: LOC, nickname: '셋', owner_hash: 'secret', created_at: NOW + 5 },
    { id: 'a', location_id: LOC, nickname: '첫', owner_hash: 'secret', created_at: NOW },
  ];
  const snapshot = waitlistSnapshot(rows, NOW + 10);
  assert.deepEqual(snapshot.map((entry) => entry.id), ['a', 'b', 'z']);
  assert.deepEqual(Object.keys(snapshot[0]).sort(), ['createdAt', 'id', 'locationId', 'nickname']);
  assert.ok(!JSON.stringify(snapshot).includes('secret'));
});

test('차례 예상: 사용 중, 종료됨, 미등록 건조기', () => {
  const min = 60_000;
  assert.deepEqual(estimateTurns({ endsAt: NOW + 10 * min, defaultMinutes: 45 }, 3, NOW), [NOW + 10 * min, NOW + 55 * min, NOW + 100 * min]);
  assert.deepEqual(estimateTurns({ endsAt: NOW - min, defaultMinutes: 45 }, 2, NOW), [NOW, NOW + 45 * min]);
  assert.deepEqual(estimateTurns({ endsAt: null, defaultMinutes: 45 }, 2, NOW), [NOW, NOW + 45 * min]);
  assert.deepEqual(estimateTurns({ endsAt: null, defaultMinutes: 45 }, 0, NOW), []);
});

test('토큰 해시는 항상 같은 64자리 16진수', async () => {
  const a = await hashToken('token');
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, await hashToken('token'));
  assert.notEqual(a, await hashToken('token2'));
});
