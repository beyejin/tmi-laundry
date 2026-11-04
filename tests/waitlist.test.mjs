import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './schema.mjs';
import { EVENT_KINDS, eventInsert } from '../lib/events.ts';
import { mutationQuery } from '../lib/laundry.ts';
import { adminRemoveQuery } from '../lib/admin.ts';
import { WAITLIST_LIMIT, WAITLIST_TTL_MS, estimateTurns, hashToken, joinQuery, leaveQuery, turnQuery, parseWaitlistCommand, waitlistSnapshot, expiredCleanupQuery, expireHeadChangeQuery, entryMetaQuery, headChangeAfterDeleteQuery, skipStatsAfterHeadChangeQuery, SKIP_AFTER_MS, HEAD_CHANGE_KIND, canSkip, dryerFreeSince, headQuery, lastChangeQuery, skipQuery, turnSince } from '../lib/waitlist.ts';

const LOC = 'h3-women-2';
const NOW = 1_800_000_000_000;

function setup() {
  const db = createDb();
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
  assert.deepEqual({ ...t.leave('a', hash) }, { id: 'a', location_id: LOC });
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

const DRYER = 'h3-women-2-dryer-1';
const bind = (q) => Object.fromEntries(q.values.map((value, index) => [String(index + 1), value]));

// 실제 D1 batch 대신 BEGIN; 시작; 대기 정리; COMMIT 순서로 같은 흐름을 재현해요.
function startWithTurn(t, { expectedVersion, entryId = 'a', hash, locationId = LOC, now = NOW + 5_000 }) {
  const start = mutationQuery(DRYER, { action: 'start', expectedVersion }, now);
  const turn = turnQuery({ entryId, ownerHash: hash, locationId, machineId: DRYER, newVersion: expectedVersion + 1, now });
  const metaQuery = entryMetaQuery(entryId);
  const meta = t.db.prepare(metaQuery.sql).get(bind(metaQuery));
  t.db.exec('BEGIN');
  const started = t.db.prepare(start.sql).get(bind(start));
  const removed = t.db.prepare(turn.sql).get(bind(turn));
  if (meta) { const change = headChangeAfterDeleteQuery({ locationId: meta.location_id, entryId, entryCreatedAt: meta.created_at, now }); t.db.prepare(change.sql).run(bind(change)); }
  t.db.exec('COMMIT');
  return { started, removed };
}

test('대기 정리: 시작 성공이면 내 항목 삭제, 기존 기기 행도 마찬가지', () => {
  const t = setup();
  t.join('a', '301호', NOW, LOC, 'mine');
  t.db.prepare('INSERT INTO machine_state (id, ends_at, updated_at, version) VALUES (?1, NULL, ?2, 3)').run(DRYER, NOW);
  const { started, removed } = startWithTurn(t, { expectedVersion: 3, hash: 'mine' });
  assert.equal(started.version, 4);
  assert.equal(removed?.id, 'a');
  assert.equal(t.rows().length, 0);
  t.db.close();
});

test('대기 정리: 신규 기기 행(expectedVersion 0 -> 1)도 삭제', () => {
  const t = setup();
  t.join('a', '301호', NOW, LOC, 'mine');
  const { started, removed } = startWithTurn(t, { expectedVersion: 0, hash: 'mine' });
  assert.equal(started.version, 1);
  assert.equal(removed?.id, 'a');
  t.db.close();
});

test('대기 정리: 시작이 버전 불일치로 실패하면 명단 유지', () => {
  const t = setup();
  t.join('a', '301호', NOW, LOC, 'mine');
  t.db.prepare('INSERT INTO machine_state (id, ends_at, updated_at, version) VALUES (?1, NULL, ?2, 3)').run(DRYER, NOW);
  const { started, removed } = startWithTurn(t, { expectedVersion: 2, hash: 'mine' });
  assert.equal(started, undefined);
  assert.equal(removed, undefined);
  assert.equal(t.rows().length, 1);
  t.db.close();
});

test('대기 정리: 가동 중 재시작이 막히면 명단 유지', () => {
  const t = setup();
  t.join('a', '301호', NOW, LOC, 'mine');
  t.db.prepare('INSERT INTO machine_state (id, ends_at, updated_at, version) VALUES (?1, ?2, ?3, 3)').run(DRYER, NOW + 60 * 60_000, NOW);
  const { started, removed } = startWithTurn(t, { expectedVersion: 3, hash: 'mine' });
  assert.equal(started, undefined);
  assert.equal(removed, undefined);
  assert.equal(t.rows().length, 1);
  t.db.close();
});

test('대기 정리: 남의 해시나 다른 층 항목은 시작이 성공해도 유지', () => {
  const t = setup();
  t.join('a', '301호', NOW, LOC, 'mine');
  t.join('b', '302호', NOW, 'h3-women-3', 'mine');
  assert.equal(startWithTurn(t, { expectedVersion: 0, hash: 'other' }).removed, undefined);
  t.db.prepare('DELETE FROM machine_state').run();
  assert.equal(startWithTurn(t, { expectedVersion: 0, entryId: 'b', hash: 'mine' }).removed, undefined);
  assert.equal(t.rows().length, 2);
  t.db.close();
});

// 같은 밀리초 경합: 이긴 요청의 행이 version = 기대값+1, updated_at = now를 이미 만족해서 EXISTS만으로는 진 요청도 통과해요.
for (const expectedVersion of [0, 3]) {
  test(`대기 정리: 같은 밀리초에 진 요청은 자기 항목을 지우지 못함 (expectedVersion ${expectedVersion})`, () => {
    const t = setup();
    t.join('win', '301호', NOW, LOC, 'winner');
    t.join('lose', '302호', NOW, LOC, 'loser');
    if (expectedVersion > 0) t.db.prepare('INSERT INTO machine_state (id, ends_at, updated_at, version) VALUES (?1, NULL, ?2, ?3)').run(DRYER, NOW, expectedVersion);
    const same = { expectedVersion, now: NOW + 5_000 };
    const winner = startWithTurn(t, { ...same, entryId: 'win', hash: 'winner' });
    assert.equal(winner.started.version, expectedVersion + 1);
    assert.equal(winner.removed?.id, 'win');
    const loser = startWithTurn(t, { ...same, entryId: 'lose', hash: 'loser' });
    assert.equal(loser.started, undefined);
    assert.equal(loser.removed, undefined);
    assert.deepEqual(t.rows().map((row) => row.id), ['lose']);
    t.db.close();
  });
}

// ---- 건너뛰기 ----

test('dryerFreeSince: 점검, 사용 중, 종료됨, 행 없음', () => {
  assert.equal(dryerFreeSince({ endsAt: NOW - 1000, updatedAt: NOW - 1000, outOfService: true }, NOW), null);
  assert.equal(dryerFreeSince({ endsAt: NOW + 1, updatedAt: NOW - 5, outOfService: false }, NOW), null);
  assert.equal(dryerFreeSince({ endsAt: NOW, updatedAt: NOW - 5, outOfService: false }, NOW), NOW);
  assert.equal(dryerFreeSince({ endsAt: NOW - 60_000, updatedAt: NOW - 5, outOfService: false }, NOW), NOW - 60_000);
  assert.equal(dryerFreeSince({ endsAt: null, updatedAt: NOW - 7, outOfService: false }, NOW), NOW - 7);
  assert.equal(dryerFreeSince({ endsAt: null, updatedAt: null, outOfService: false }, NOW), 0);
});

test('turnSince: 등록, 건조기 비움, 마지막 변동 중 가장 늦은 값', () => {
  assert.equal(turnSince({ createdAt: 100 }, 50, null), 100);
  assert.equal(turnSince({ createdAt: 100 }, 300, null), 300);
  assert.equal(turnSince({ createdAt: 100 }, 300, 200), 300);
  assert.equal(turnSince({ createdAt: 100 }, 300, 400), 400);
  assert.equal(turnSince({ createdAt: 100 }, 0, null), 100);
});

test('canSkip: 9분59초는 대기, 10분은 허용, 사용 중과 점검은 사유 반환', () => {
  const free = { endsAt: null, updatedAt: null, outOfService: false };
  const head = { createdAt: NOW };
  assert.deepEqual(canSkip({ head, dryer: free, lastChangeAt: null, now: NOW + SKIP_AFTER_MS - 1 }), { ok: false, reason: 'wait', waitMs: 1 });
  assert.deepEqual(canSkip({ head, dryer: free, lastChangeAt: null, now: NOW + SKIP_AFTER_MS }), { ok: true });
  assert.deepEqual(canSkip({ head, dryer: free, lastChangeAt: NOW + 60_000, now: NOW + SKIP_AFTER_MS }), { ok: false, reason: 'wait', waitMs: 60_000 });
  assert.deepEqual(canSkip({ head, dryer: { ...free, endsAt: NOW + SKIP_AFTER_MS + 60_000 }, lastChangeAt: null, now: NOW + SKIP_AFTER_MS }), { ok: false, reason: 'busy' });
  assert.deepEqual(canSkip({ head, dryer: { ...free, outOfService: true }, lastChangeAt: null, now: NOW + SKIP_AFTER_MS * 5 }), { ok: false, reason: 'service' });
  // 건조기가 늦게 끝나면 끝난 시각부터 10분을 세요.
  const ended = { ...free, endsAt: NOW + 30 * 60_000 };
  assert.equal(canSkip({ head, dryer: ended, lastChangeAt: null, now: NOW + 30 * 60_000 + SKIP_AFTER_MS - 1 }).ok, false);
  assert.equal(canSkip({ head, dryer: ended, lastChangeAt: null, now: NOW + 30 * 60_000 + SKIP_AFTER_MS }).ok, true);
});

test('건너뛰기 명령 검증: id만 필요', () => {
  assert.deepEqual(parseWaitlistCommand({ action: 'skip', id: 'abc-1' }), { action: 'skip', id: 'abc-1' });
  for (const bad of [{ action: 'skip' }, { action: 'skip', id: '' }, { action: 'skip', id: 'a b' }, { action: 'skip', id: 5 }]) assert.equal(parseWaitlistCommand(bad), null, JSON.stringify(bad));
});

// route.ts의 batch와 같은 순서로 문장을 실행해요. 각 문장의 반환 행을 모아 돌려줘요.
function batch(t, queries) {
  t.db.exec('BEGIN');
  try { return queries.map((q) => t.db.prepare(q.sql).all(bind(q))); } finally { t.db.exec('COMMIT'); }
}
const headChanges = (t) => t.db.prepare("SELECT at, location_id FROM event_log WHERE kind = 'waitlist_head_change' ORDER BY at, id").all().map((row) => ({ ...row }));
const countKind = (t, kind) => t.db.prepare('SELECT COUNT(*) AS n FROM event_log WHERE kind = ?1').get(kind).n;
const meta = (t, id) => { const q = entryMetaQuery(id); return t.db.prepare(q.sql).get(bind(q)); };
const headChange = (t, id, now) => { const m = meta(t, id); return headChangeAfterDeleteQuery({ locationId: m.location_id, entryId: id, entryCreatedAt: m.created_at, now }); };

function skipRun(t, id, now, locationId = LOC) {
  const q = skipQuery({ id, locationId, dryerId: DRYER }, now);
  return t.db.prepare(q.sql).get(bind(q));
}

// route.ts skip()과 같은 batch: 삭제, 맨 앞 변동 표식, 통계 기록.
function skipBatch(t, id, now, locationId = LOC) {
  const m = meta(t, id);
  const [deleted] = batch(t, [skipQuery({ id, locationId, dryerId: DRYER }, now), headChangeAfterDeleteQuery({ locationId, entryId: id, entryCreatedAt: m.created_at, now }), skipStatsAfterHeadChangeQuery(locationId, now)]);
  return deleted[0];
}

test('skipQuery: 맨 앞이 아니면 삭제 안 함, 맨 앞이면 삭제', () => {
  const t = setup();
  t.join('a', '301호', NOW);
  t.join('b', '302호', NOW + 1);
  assert.equal(skipRun(t, 'b', NOW + SKIP_AFTER_MS), undefined);
  assert.equal(t.rows().length, 2);
  assert.equal(skipRun(t, 'a', NOW + SKIP_AFTER_MS)?.id, 'a');
  assert.deepEqual(t.rows().map((row) => row.id), ['b']);
  t.db.close();
});

test('skipQuery: 층이 다르거나 아직 10분이 안 된 맨 앞은 SQL이 거절', () => {
  const t = setup();
  t.join('a', '301호', NOW);
  assert.equal(skipRun(t, 'a', NOW + SKIP_AFTER_MS - 1), undefined);
  assert.equal(skipRun(t, 'a', NOW + SKIP_AFTER_MS, 'h3-women-3'), undefined);
  assert.equal(skipRun(t, 'a', NOW + SKIP_AFTER_MS)?.id, 'a');
  t.db.close();
});

test('skipQuery: 건조기 사용 중이거나 점검 중이면 삭제 안 함, 끝난 지 10분이 지나야 삭제', () => {
  const t = setup();
  t.join('a', '301호', NOW - 60 * 60_000);
  const now = NOW;
  t.db.prepare('INSERT INTO machine_state (id, ends_at, updated_at, version) VALUES (?1, ?2, ?3, 1)').run(DRYER, now + 1, now - 1000);
  assert.equal(skipRun(t, 'a', now), undefined);
  t.db.prepare('UPDATE machine_state SET ends_at = ?2 WHERE id = ?1').run(DRYER, now - SKIP_AFTER_MS + 1);
  assert.equal(skipRun(t, 'a', now), undefined);
  t.db.prepare('UPDATE machine_state SET ends_at = ?2 WHERE id = ?1').run(DRYER, now - SKIP_AFTER_MS);
  assert.equal(skipRun(t, 'a', now)?.id, 'a');
  t.join('c', '303호', NOW - 60 * 60_000);
  t.db.prepare('UPDATE machine_state SET ends_at = NULL, out_of_service = 1 WHERE id = ?1').run(DRYER);
  assert.equal(skipRun(t, 'c', now + 5 * SKIP_AFTER_MS), undefined);
  assert.equal(t.rows().length, 1);
  t.db.close();
});

test('skipQuery: 만료된 맨 앞은 head가 아니므로 거절하고, 만료 직후 10분은 다음 사람도 거절', () => {
  const t = setup();
  t.join('old', '301호', NOW);
  t.join('new', '302호', NOW + 20 * 60_000);
  const expiredAt = NOW + WAITLIST_TTL_MS;
  assert.equal(skipRun(t, 'old', expiredAt + 1), undefined);
  assert.equal(skipRun(t, 'new', expiredAt + 1), undefined); // 아직 정리 전인 만료 행이 방금 맨 앞이 바뀐 것으로 잡혀요
  assert.equal(skipRun(t, 'new', expiredAt + SKIP_AFTER_MS - 1), undefined);
  assert.equal(skipRun(t, 'new', expiredAt + SKIP_AFTER_MS)?.id, 'new');
  t.db.close();
});

test('정렬 일치: created_at이 같으면 id 순서가 waitlistSnapshot과 SQL head에서 같음', () => {
  const t = setup();
  t.join('zzz', '301호', NOW);
  t.join('aaa', '302호', NOW);
  t.join('mmm', '303호', NOW);
  const snapshotHead = waitlistSnapshot(t.rows(), NOW + 1)[0].id;
  const q = headQuery(LOC, NOW + 1);
  assert.equal(t.db.prepare(q.sql).get(bind(q)).id, snapshotHead);
  assert.equal(snapshotHead, 'aaa');
  assert.equal(skipRun(t, 'zzz', NOW + SKIP_AFTER_MS), undefined);
  assert.equal(skipRun(t, 'aaa', NOW + SKIP_AFTER_MS)?.id, 'aaa');
  t.db.close();
});

test('lastChangeQuery: 층별 맨 앞 변동 표식의 최댓값만, 다른 종류와 만료 이전 표식은 제외', () => {
  const t = setup();
  const log = (event, now) => { const q = eventInsert(event, now); t.db.prepare(q.sql).run(bind(q)); };
  log({ kind: 'waitlist_head_change', locationId: LOC }, NOW + 10);
  log({ kind: 'waitlist_head_change', locationId: LOC }, NOW + 30);
  log({ kind: 'waitlist_head_change', locationId: 'h3-women-3' }, NOW + 20);
  for (const kind of ['waitlist_leave', 'waitlist_turn', 'waitlist_skip', 'admin_remove', 'waitlist_join']) log({ kind, locationId: LOC }, NOW + 99);
  log({ kind: 'waitlist_head_change', locationId: 'h3-women-4' }, NOW - WAITLIST_TTL_MS - 5);
  const q = lastChangeQuery(NOW + 100);
  const rows = Object.fromEntries(t.db.prepare(q.sql).all(bind(q)).map((row) => [row.location_id, row.last_at]));
  assert.deepEqual(rows, { [LOC]: NOW + 30, 'h3-women-3': NOW + 20 });
  assert.ok(EVENT_KINDS.includes(HEAD_CHANGE_KIND));
  t.db.close();
});

test('lastChangeQuery: 정리 전 만료 행은 가장 늦은 등록 시각 + TTL을 변동으로 포함', () => {
  const t = setup();
  t.join('e1', '301호', NOW);
  t.join('e2', '302호', NOW + 5_000);
  t.join('v', '303호', NOW + 60_000);
  const q = lastChangeQuery(NOW + WAITLIST_TTL_MS + 10_000);
  const rows = Object.fromEntries(t.db.prepare(q.sql).all(bind(q)).map((row) => [row.location_id, row.last_at]));
  assert.deepEqual(rows, { [LOC]: NOW + 5_000 + WAITLIST_TTL_MS });
  t.db.close();
});

test('맨 앞 변동: 맨 앞이 아닌 사람의 취소·재등록은 표식도 없고 맨 앞의 10분을 늘리지도 않음', () => {
  const t = setup();
  t.join('a', '301호', NOW, LOC, 'ha');
  t.join('b', '302호', NOW + 1, LOC, 'hb');
  const at = NOW + 9 * 60_000;
  const [left] = batch(t, [leaveQuery('b', 'hb'), headChange(t, 'b', at)]);
  assert.equal(left[0].id, 'b');
  assert.deepEqual(headChanges(t), []);
  t.join('c', '303호', at + 1000, LOC, 'hc');
  assert.equal(skipRun(t, 'a', NOW + SKIP_AFTER_MS)?.id, 'a');
  t.db.close();
});

test('맨 앞 변동: 맨 앞이 빠지면 표식이 남고 다음 사람은 그때부터 10분 뒤에 건너뛸 수 있음', () => {
  const t = setup();
  t.join('a', '301호', NOW, LOC, 'ha');
  t.join('b', '302호', NOW + 1, LOC, 'hb');
  const at = NOW + 9 * 60_000;
  // 남의 해시로 지우려는 시도는 아무것도 지우지 못하고 표식도 없어요.
  batch(t, [leaveQuery('a', 'wrong'), headChange(t, 'a', at)]);
  assert.deepEqual(headChanges(t), []);
  batch(t, [leaveQuery('a', 'ha'), headChange(t, 'a', at)]);
  assert.deepEqual(headChanges(t), [{ at, location_id: LOC }]);
  assert.equal(skipRun(t, 'b', at + SKIP_AFTER_MS - 1), undefined);
  assert.equal(skipRun(t, 'b', at + SKIP_AFTER_MS)?.id, 'b');
  t.db.close();
});

test('맨 앞 변동: 이미 만료된 항목이 빠지는 것은 표식을 남기지 않음(만료 때 따로 기록)', () => {
  const t = setup();
  t.join('old', '301호', NOW, LOC, 'ho');
  const now = NOW + WAITLIST_TTL_MS + 1;
  batch(t, [leaveQuery('old', 'ho'), headChange(t, 'old', now)]);
  assert.deepEqual(headChanges(t), []);
  t.db.close();
});

test('연쇄 건너뛰기: 1번을 건너뛴 뒤 2번은 10분 동안 SQL이 거절(JS 검사를 우회해 skipQuery를 직접 호출)', () => {
  const t = setup();
  for (let i = 1; i <= 4; i += 1) t.join(`e${i}`, `${i}호`, NOW - 60 * 60_000 + i);
  const T = NOW;
  assert.equal(skipBatch(t, 'e1', T)?.id, 'e1');
  assert.equal(countKind(t, 'waitlist_skip'), 1);
  assert.deepEqual(headChanges(t), [{ at: T, location_id: LOC }]);
  // 같은 밀리초에 온 2번, 9분59초에 온 2번, 모두 거절되고 아무 기록도 늘지 않아요.
  assert.equal(skipBatch(t, 'e2', T), undefined);
  assert.equal(skipBatch(t, 'e2', T + SKIP_AFTER_MS - 1), undefined);
  assert.equal(countKind(t, 'waitlist_skip'), 1);
  assert.equal(headChanges(t).length, 1);
  assert.equal(skipBatch(t, 'e2', T + SKIP_AFTER_MS)?.id, 'e2');
  assert.equal(skipBatch(t, 'e3', T + SKIP_AFTER_MS + 1), undefined);
  assert.deepEqual(t.rows().map((row) => row.id), ['e3', 'e4']);
  assert.equal(countKind(t, 'waitlist_skip'), 2);
  assert.equal(headChanges(t).length, 2);
  t.db.close();
});

test('만료로 맨 앞이 바뀌면: 정리 전에도, 정리 후(join 경로 batch)에도 다음 사람은 만료 시각부터 10분 뒤에 건너뛸 수 있음', () => {
  for (const cleanup of [false, true]) {
    const t = setup();
    t.join('h', '301호', NOW);
    t.join('n', '302호', NOW + 20 * 60_000);
    const expiredAt = NOW + WAITLIST_TTL_MS;
    if (cleanup) {
      // join 경로: [만료 표식, 만료 정리, 새 등록]. 정리는 만료 후 5분에 일어났어요.
      const at = expiredAt + 5 * 60_000;
      const [mark, , inserted] = batch(t, [expireHeadChangeQuery(at), expiredCleanupQuery(at), joinQuery({ id: 'z', locationId: LOC, nickname: '새사람', ownerHash: 'hz' }, at)]);
      assert.equal(mark.length, 0);
      assert.equal(inserted[0].id, 'z');
      assert.deepEqual(headChanges(t), [{ at: expiredAt, location_id: LOC }]);
      assert.deepEqual(t.rows().map((row) => row.id), ['n', 'z']);
    }
    assert.equal(skipRun(t, 'n', expiredAt + SKIP_AFTER_MS - 1), undefined, `cleanup=${cleanup}`);
    assert.equal(skipRun(t, 'n', expiredAt + SKIP_AFTER_MS)?.id, 'n', `cleanup=${cleanup}`);
    t.db.close();
  }
});

test('만료 표식: 층별로 가장 늦은 만료 시각 하나, 만료 행이 없으면 없음, 한 번 정리한 뒤 다시 실행해도 중복 없음', () => {
  const t = setup();
  t.join('v', '301호', NOW + 1000);
  const none = expireHeadChangeQuery(NOW + 10);
  batch(t, [none]);
  assert.deepEqual(headChanges(t), []);
  t.join('e1', '302호', NOW);
  t.join('e2', '303호', NOW + 500);
  t.join('o', '304호', NOW, 'h3-women-3');
  const now = NOW + WAITLIST_TTL_MS + 600;
  batch(t, [expireHeadChangeQuery(now), expiredCleanupQuery(now)]);
  batch(t, [expireHeadChangeQuery(now), expiredCleanupQuery(now)]);
  assert.deepEqual(headChanges(t).sort((x, y) => x.at - y.at), [{ at: NOW + WAITLIST_TTL_MS, location_id: 'h3-women-3' }, { at: NOW + 500 + WAITLIST_TTL_MS, location_id: LOC }]);
  t.db.close();
});

test('차례 정리: 맨 앞이 시작해서 빠지면 표식, 맨 앞이 아니면 표식 없음', () => {
  for (const [entryId, hash, expected] of [['a', 'ha', 1], ['b', 'hb', 0]]) {
    const t = setup();
    t.join('a', '301호', NOW, LOC, 'ha');
    t.join('b', '302호', NOW + 1, LOC, 'hb');
    const { removed } = startWithTurn(t, { expectedVersion: 0, entryId, hash });
    assert.equal(removed?.id, entryId);
    assert.equal(headChanges(t).length, expected, entryId);
    t.db.close();
  }
});

test('차례 정리: 같은 밀리초 경합에서 진 요청은 항목도 표식도 만들지 않음', () => {
  const t = setup();
  t.join('a', '301호', NOW, LOC, 'ha');
  t.join('b', '302호', NOW + 1, LOC, 'hb');
  const same = { expectedVersion: 0, now: NOW + 5_000 };
  assert.equal(startWithTurn(t, { ...same, entryId: 'a', hash: 'ha' }).removed?.id, 'a');
  assert.equal(headChanges(t).length, 1);
  const loser = startWithTurn(t, { ...same, entryId: 'b', hash: 'hb' });
  assert.equal(loser.started, undefined);
  assert.equal(loser.removed, undefined);
  assert.equal(headChanges(t).length, 1);
  assert.deepEqual(t.rows().map((row) => row.id), ['b']);
  t.db.close();
});

test('관리자 삭제: 맨 앞이면 표식, 맨 앞이 아니면 표식 없음', () => {
  const t = setup();
  t.join('a', '301호', NOW);
  t.join('b', '302호', NOW + 1);
  t.join('c', '303호', NOW + 2);
  const at = NOW + 1000;
  const [mid] = batch(t, [adminRemoveQuery('b'), headChange(t, 'b', at)]);
  assert.equal(mid[0].id, 'b');
  assert.deepEqual(headChanges(t), []);
  const [head] = batch(t, [adminRemoveQuery('a'), headChange(t, 'a', at)]);
  assert.equal(head[0].location_id, LOC);
  assert.deepEqual(headChanges(t), [{ at, location_id: LOC }]);
  t.db.close();
});

// SQL(skipQuery)과 JS(canSkip + lastChangeQuery)가 같은 판정을 내리는지 조합표로 확인해요. 경계: 9분59.999초 / 10분.
test('SQL과 canSkip 일치: 등록 나이, 건조기 상태, 맨 앞 변동 표식, 정리 전 만료 행의 모든 조합', () => {
  const now = NOW;
  const ages = [SKIP_AFTER_MS - 1, SKIP_AFTER_MS, SKIP_AFTER_MS + 1];
  const dryers = [
    ['행 없음', null],
    ['사용 중(ends_at 미래)', { ends_at: now + 1, updated_at: now - 10 * SKIP_AFTER_MS, out_of_service: 0 }],
    ['점검 중', { ends_at: null, updated_at: now - 10 * SKIP_AFTER_MS, out_of_service: 1 }],
    ['끝난 지 9:59.999', { ends_at: now - SKIP_AFTER_MS + 1, updated_at: now - 10 * SKIP_AFTER_MS, out_of_service: 0 }],
    ['끝난 지 10:00', { ends_at: now - SKIP_AFTER_MS, updated_at: now, out_of_service: 0 }],
    ['ends_at 없음 + 수정 9:59.999 전', { ends_at: null, updated_at: now - SKIP_AFTER_MS + 1, out_of_service: 0 }],
    ['ends_at 없음 + 수정 10:00 전', { ends_at: null, updated_at: now - SKIP_AFTER_MS, out_of_service: 0 }],
    ['ends_at 없음 + 오래전 수정', { ends_at: null, updated_at: 5, out_of_service: 0 }],
  ];
  const marks = [null, now - SKIP_AFTER_MS + 1, now - SKIP_AFTER_MS, now - SKIP_AFTER_MS - 1];
  const expired = [null, now - WAITLIST_TTL_MS - SKIP_AFTER_MS, now - WAITLIST_TTL_MS - SKIP_AFTER_MS + 1, now - WAITLIST_TTL_MS];
  let cases = 0;
  let allowed = 0;
  for (const age of ages) for (const [dryerName, dryer] of dryers) for (const mark of marks) for (const exp of expired) {
    const t = setup();
    t.join('head', '301호', now - age);
    if (exp !== null) t.join('expired', '302호', exp);
    if (dryer) t.db.prepare('INSERT INTO machine_state (id, ends_at, updated_at, version, out_of_service) VALUES (?1, ?2, ?3, 1, ?4)').run(DRYER, dryer.ends_at, dryer.updated_at, dryer.out_of_service);
    if (mark !== null) { const q = eventInsert({ kind: 'waitlist_head_change', locationId: LOC }, mark); t.db.prepare(q.sql).run(bind(q)); }
    const hq = headQuery(LOC, now);
    const head = t.db.prepare(hq.sql).get(bind(hq));
    const lq = lastChangeQuery(now);
    const lastChange = Object.fromEntries(t.db.prepare(lq.sql).all(bind(lq)).map((row) => [row.location_id, row.last_at]))[LOC] ?? null;
    const js = canSkip({ head: { createdAt: head.created_at }, dryer: { endsAt: dryer?.ends_at ?? null, updatedAt: dryer?.updated_at ?? null, outOfService: Boolean(dryer?.out_of_service) }, lastChangeAt: lastChange, now });
    const sql = skipRun(t, 'head', now);
    const label = `age=${age} dryer=${dryerName} mark=${mark} expired=${exp}`;
    assert.equal(Boolean(sql), js.ok, label);
    cases += 1;
    if (js.ok) allowed += 1;
    t.db.close();
  }
  assert.equal(cases, ages.length * dryers.length * marks.length * expired.length);
  assert.ok(allowed > 0 && allowed < cases, `허용 ${allowed}/${cases}`);
});

test('경계: 등록 후 정확히 9분59.999초는 거절, 10분은 허용(건조기 행 없음)', () => {
  const t = setup();
  t.join('a', '301호', NOW);
  assert.equal(skipRun(t, 'a', NOW + 599_999), undefined);
  assert.equal(skipRun(t, 'a', NOW + 600_000)?.id, 'a');
  t.db.close();
});
