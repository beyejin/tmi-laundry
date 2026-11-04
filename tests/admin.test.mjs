import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './schema.mjs';
import { MACHINES, SERVICE_MESSAGE, machineStatus, mutationQuery, stateSnapshot } from '../lib/laundry.ts';
import { joinQuery, dryersInServiceQuery } from '../lib/waitlist.ts';
import { eventInsert, reportQuery, EVENT_KINDS } from '../lib/events.ts';
import {
  CSV_HEADER, accuracyQuery, adminRemoveQuery, csvCell, csvLine, csvQuery, hourlyDistribution, hourlyQuery, isAdmin, kstDateString, kstDayStart, kstDateTimeString,
  normalizeServiceNote, parseAdminMachineCommand, parseAdminWaitlistCommand, parseCsvRange, periodStarts, reportCountsQuery, resetQuery, safeEqualBytes, serviceQuery,
  statsQuery, summarizeAccuracy, summarizeStats, DAY_MS,
} from '../lib/admin.ts';

const NOW = 1_800_000_000_000;
const WASHER = 'h3-women-2-washer-1';
const DRYER = 'h3-women-2-dryer-1';
const LOC = 'h3-women-2';
const bind = (q) => Object.fromEntries(q.values.map((value, index) => [String(index + 1), value]));
const get = (db, q) => db.prepare(q.sql).get(bind(q));
const all = (db, q) => db.prepare(q.sql).all(bind(q));
const run = (db, q) => db.prepare(q.sql).run(bind(q));
const req = (token) => new Request('http://x/api/admin/overview', token === undefined ? {} : { headers: { authorization: token } });
const TOKEN = 'a-long-admin-token-with-24+chars';

test('safeEqualBytes: 길이가 다르면 false, 같은 값은 true, 주입한 비교 함수를 우선 사용', () => {
  const a = new Uint8Array([1, 2, 3]);
  assert.equal(safeEqualBytes(a, new Uint8Array([1, 2, 3])), true);
  assert.equal(safeEqualBytes(a, new Uint8Array([1, 2, 4])), false);
  assert.equal(safeEqualBytes(a, new Uint8Array([1, 2])), false);
  let called = 0;
  assert.equal(safeEqualBytes(a, new Uint8Array([9, 9, 9]), () => { called += 1; return true; }), true);
  assert.equal(called, 1);
  assert.equal(safeEqualBytes(a, new Uint8Array([9]), () => true), false, '길이가 다르면 비교 함수를 부르지 않아요');
});

test('isAdmin: 토큰이 없거나 24자 미만이면 항상 거부, 틀린 값 거부, 맞는 값만 통과 (네이티브 비교 없이도 동작)', async () => {
  assert.equal(await isAdmin(req(`Bearer ${TOKEN}`), undefined, null), false);
  assert.equal(await isAdmin(req('Bearer short'), 'short', null), false);
  assert.equal(await isAdmin(req(`Bearer ${'x'.repeat(23)}`), 'x'.repeat(23), null), false, '23자는 짧아요');
  assert.equal(await isAdmin(req(), TOKEN, null), false);
  assert.equal(await isAdmin(req(TOKEN), TOKEN, null), false, 'Bearer 접두어가 없으면 거부');
  assert.equal(await isAdmin(req('Bearer '), TOKEN, null), false);
  assert.equal(await isAdmin(req(`Bearer ${TOKEN}x`), TOKEN, null), false);
  assert.equal(await isAdmin(req(`Bearer ${TOKEN}`), TOKEN, null), true);
  assert.equal(await isAdmin(req(`Bearer ${'x'.repeat(24)}`), 'x'.repeat(24), null), true, '정확히 24자는 허용');
  assert.equal(await isAdmin(req(`Bearer ${TOKEN}`), TOKEN, (a, b) => a.every((v, i) => v === b[i])), true);
});

test('점검 메모 검증과 관리자 명령 파싱', () => {
  assert.deepEqual(normalizeServiceNote('  배수 불량  '), { ok: true, note: '배수 불량' });
  assert.deepEqual(normalizeServiceNote(undefined), { ok: true, note: null });
  assert.deepEqual(normalizeServiceNote('   '), { ok: true, note: null });
  assert.deepEqual(normalizeServiceNote('가'.repeat(40)), { ok: true, note: '가'.repeat(40) });
  assert.deepEqual(normalizeServiceNote('가'.repeat(41)), { ok: false });
  assert.deepEqual(normalizeServiceNote('a\nb'), { ok: false });
  assert.deepEqual(normalizeServiceNote(5), { ok: false });
  assert.deepEqual(parseAdminMachineCommand({ action: 'service', on: true, note: ' 수리 ' }), { action: 'service', on: true, note: '수리' });
  assert.deepEqual(parseAdminMachineCommand({ action: 'service', on: false, note: '남은 메모' }), { action: 'service', on: false, note: null });
  assert.deepEqual(parseAdminMachineCommand({ action: 'reset' }), { action: 'reset' });
  for (const bad of [null, [], {}, { action: 'service' }, { action: 'service', on: 'yes' }, { action: 'service', on: true, note: 'x'.repeat(41) }, { action: 'other' }]) assert.equal(parseAdminMachineCommand(bad), null, JSON.stringify(bad));
  assert.deepEqual(parseAdminWaitlistCommand({ action: 'remove', id: 'abc-1' }), { action: 'remove', id: 'abc-1' });
  for (const bad of [null, {}, { action: 'remove' }, { action: 'remove', id: 'a b' }, { action: 'leave', id: 'abc' }]) assert.equal(parseAdminWaitlistCommand(bad), null);
});

test('serviceQuery: 행이 없으면 만들고, 있으면 version을 올리며 ends_at을 비움', () => {
  const db = createDb();
  const created = get(db, serviceQuery(WASHER, true, '배수 불량', NOW));
  assert.deepEqual({ ends_at: created.ends_at, version: created.version, out: created.out_of_service, note: created.service_note, updated: created.updated_at }, { ends_at: null, version: 1, out: 1, note: '배수 불량', updated: NOW });
  db.prepare('UPDATE machine_state SET ends_at = ?1 WHERE id = ?2').run(NOW + 60_000, WASHER);
  const again = get(db, serviceQuery(WASHER, true, '수리 중', NOW + 1));
  assert.deepEqual({ ends_at: again.ends_at, version: again.version, note: again.service_note }, { ends_at: null, version: 2, note: '수리 중' });
  const off = get(db, serviceQuery(WASHER, false, '무시됨', NOW + 2));
  assert.deepEqual({ out: off.out_of_service, note: off.service_note, version: off.version }, { out: 0, note: null, version: 3 });
  const other = get(db, serviceQuery(DRYER, true, null, NOW));
  assert.equal(other.version, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM machine_state').get().n, 2);
});

test('resetQuery: ends_at을 비우고 version을 올림, 행이 없으면 아무 일도 없음', () => {
  const db = createDb();
  assert.equal(get(db, resetQuery(WASHER, NOW)), undefined);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM machine_state').get().n, 0);
  get(db, mutationQuery(WASHER, { action: 'start', expectedVersion: 0 }, NOW));
  const reset = get(db, resetQuery(WASHER, NOW + 5));
  assert.deepEqual({ ends_at: reset.ends_at, version: reset.version, updated: reset.updated_at }, { ends_at: null, version: 2, updated: NOW + 5 });
});

test('mutationQuery: 점검 중이면 start/adjust/clear 모두 거부, 점검 해제 뒤 허용, 새 행 INSERT도 점검 행과 충돌하면 거부', () => {
  const db = createDb();
  get(db, mutationQuery(WASHER, { action: 'start', expectedVersion: 0 }, NOW));
  const service = get(db, serviceQuery(WASHER, true, null, NOW + 1));
  for (const command of [{ action: 'start', expectedVersion: service.version }, { action: 'adjust', expectedVersion: service.version, minutes: 10 }, { action: 'clear', expectedVersion: service.version }]) {
    assert.equal(get(db, mutationQuery(WASHER, command, NOW + 2)), undefined, command.action);
  }
  assert.equal(get(db, mutationQuery(WASHER, { action: 'start', expectedVersion: 0 }, NOW + 2)), undefined, '낡은 version 0 요청');
  const off = get(db, serviceQuery(WASHER, false, null, NOW + 3));
  const started = get(db, mutationQuery(WASHER, { action: 'start', expectedVersion: off.version }, NOW + 4));
  assert.equal(started.version, off.version + 1);
});

test('stateSnapshot과 machineStatus: 점검 중이 최우선', () => {
  const db = createDb();
  get(db, serviceQuery(WASHER, true, '고장', NOW));
  const snapshot = stateSnapshot(db.prepare('SELECT * FROM machine_state').all(), NOW);
  const washer = snapshot.machines.find((m) => m.id === WASHER);
  assert.deepEqual({ out: washer.outOfService, note: washer.serviceNote }, { out: true, note: '고장' });
  const other = snapshot.machines.find((m) => m.id === DRYER);
  assert.deepEqual({ out: other.outOfService, note: other.serviceNote }, { out: false, note: null });
  assert.equal(machineStatus(null, NOW, true), 'service');
  assert.equal(machineStatus(NOW + 1000, NOW, true), 'service');
  assert.equal(machineStatus(NOW + 1000, NOW, false), 'running');
  assert.equal(machineStatus(null, NOW), 'unknown');
});

test('joinQuery: 층의 건조기가 모두 점검 중일 때만 대기 등록을 막음', () => {
  const db = createDb();
  const dryers = MACHINES.filter((m) => m.locationId === LOC && m.type === 'dryer').map((m) => m.id);
  assert.deepEqual(dryers, [DRYER]);
  const join = (id, nickname, ids = dryers, loc = LOC) => get(db, joinQuery({ id, locationId: loc, nickname, ownerHash: `h-${id}` }, NOW, ids));
  assert.ok(join('a', '가'), '점검 전 허용');
  get(db, serviceQuery(DRYER, true, null, NOW));
  assert.equal(get(db, dryersInServiceQuery(dryers)).n, 1);
  assert.equal(join('b', '나'), undefined, '점검 중 거부');
  assert.ok(get(db, joinQuery({ id: 'c', locationId: 'h3-women-3', nickname: '다', ownerHash: 'h' }, NOW, ['h3-women-3-dryer-1'])), '다른 층 건조기는 영향 없음');
  assert.ok(join('d', '라', []), '건조기 목록이 비면 조건 없음(기존 동작)');
  get(db, serviceQuery(DRYER, false, null, NOW + 1));
  assert.ok(join('e', '마'), '점검 해제 뒤 허용');
  // 건조기가 둘이어도 모두 점검일 때만 막는지 (placeholder 번호 충돌 없이)
  const two = ['x-dryer-1', 'x-dryer-2'];
  get(db, serviceQuery('x-dryer-1', true, null, NOW));
  assert.ok(join('f', '바', two, 'x'), '하나만 점검이면 허용');
  get(db, serviceQuery('x-dryer-2', true, null, NOW));
  assert.equal(join('g', '사', two, 'x'), undefined, '모두 점검이면 거부');
});

test('reportQuery: 기기당 10분에 3건까지, 10분 뒤 다시 허용, 다른 기기는 별개', () => {
  const db = createDb();
  const machine = { id: WASHER, locationId: LOC };
  for (let i = 0; i < 3; i += 1) assert.ok(get(db, reportQuery(machine, NOW)), `${i + 1}번째`);
  assert.equal(get(db, reportQuery(machine, NOW + 1)), undefined, '4번째 거부');
  assert.equal(get(db, reportQuery(machine, NOW + 599_999)), undefined, '10분 안이면 계속 거부');
  assert.ok(get(db, reportQuery({ id: DRYER, locationId: LOC }, NOW + 3)), '다른 기기');
  assert.ok(get(db, reportQuery(machine, NOW + 600_000)), '10분 뒤에는 다시 허용');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE kind = 'report'").get().n, 5);
  const row = db.prepare("SELECT * FROM event_log WHERE kind = 'report' LIMIT 1").get();
  assert.deepEqual({ machine: row.machine_id, minutes: row.minutes, prev: row.prev_remaining_sec }, { machine: WASHER, minutes: null, prev: null });
});

test('이벤트 종류에 관리자 기록이 포함됨', () => {
  for (const kind of ['report', 'service_on', 'service_off', 'admin_reset', 'admin_remove']) assert.ok(EVENT_KINDS.includes(kind), kind);
});

test('kstDayStart: KST 23:59와 00:00 경계', () => {
  const midnight = Date.parse('2026-11-04T00:00:00+09:00');
  assert.equal(kstDayStart(midnight), midnight);
  assert.equal(kstDayStart(midnight - 1), midnight - DAY_MS);
  assert.equal(kstDayStart(Date.parse('2026-11-04T23:59:59.999+09:00')), midnight);
  assert.equal(kstDayStart(Date.parse('2026-11-04T15:00:00Z')), Date.parse('2026-11-05T00:00:00+09:00'));
  assert.equal(kstDateString(midnight), '2026-11-04');
  assert.equal(kstDateTimeString(Date.parse('2026-11-04T07:08:09+09:00')), '2026-11-04 07:08:09');
  assert.deepEqual(periodStarts(NOW), { today: kstDayStart(NOW), week: NOW - 7 * DAY_MS, all: 0 });
});

test('summarizeAccuracy: 빈 배열, 홀수와 짝수 중앙값, 평균 절댓값', () => {
  assert.deepEqual(summarizeAccuracy([]), { count: 0, medianSec: null, meanAbsSec: null });
  const row = (prev, minutes) => ({ prev_remaining_sec: prev, minutes });
  // diff = prev - minutes*60: 60, -120, 300
  assert.deepEqual(summarizeAccuracy([row(660, 10), row(480, 10), row(900, 10)]), { count: 3, medianSec: 60, meanAbsSec: 160 });
  // diff: -60, 0, 60, 600 -> median 30
  assert.deepEqual(summarizeAccuracy([row(540, 10), row(600, 10), row(660, 10), row(1200, 10)]), { count: 4, medianSec: 30, meanAbsSec: 180 });
});

test('통계 쿼리: kind별 건수와 세탁기/건조기 시작 수, 기간, 시간대, 신고 수, 정확도 원자료', () => {
  const db = createDb();
  const add = (event) => run(db, eventInsert(event));
  add({ at: NOW, kind: 'start', locationId: LOC, machineId: WASHER, minutes: 36 });
  add({ at: NOW, kind: 'start', locationId: LOC, machineId: DRYER, minutes: 45 });
  add({ at: NOW, kind: 'start', locationId: LOC, machineId: DRYER, minutes: 45 });
  add({ at: NOW - 10 * DAY_MS, kind: 'start', locationId: LOC, machineId: WASHER, minutes: 36 });
  add({ at: NOW, kind: 'adjust', locationId: LOC, machineId: WASHER, minutes: 10, prevRemainingSec: 660 });
  add({ at: NOW, kind: 'adjust', locationId: LOC, machineId: WASHER, minutes: 10 });
  add({ at: NOW, kind: 'report', locationId: LOC, machineId: WASHER });
  add({ at: NOW, kind: 'waitlist_join', locationId: LOC });
  const week = summarizeStats(all(db, statsQuery(NOW - 7 * DAY_MS)));
  assert.deepEqual(week, { counts: { start: 3, adjust: 2, report: 1, waitlist_join: 1 }, washerStarts: 1, dryerStarts: 2 });
  const everything = summarizeStats(all(db, statsQuery(0)));
  assert.equal(everything.counts.start, 4);
  assert.equal(everything.washerStarts, 2);
  assert.deepEqual(summarizeStats([]), { counts: {}, washerStarts: 0, dryerStarts: 0 });
  const hours = hourlyDistribution(all(db, hourlyQuery(NOW - 7 * DAY_MS)));
  assert.equal(hours.length, 24);
  assert.equal(hours.reduce((a, b) => a + b, 0), 3);
  assert.equal(hours[new Date(NOW + 9 * 3_600_000).getUTCHours()], 3);
  assert.deepEqual(all(db, reportCountsQuery(NOW - DAY_MS)).map((r) => [r.machine_id, r.n]), [[WASHER, 1]]);
  assert.deepEqual(all(db, accuracyQuery(NOW - 30 * DAY_MS)).map((r) => ({ ...r })), [{ prev_remaining_sec: 660, minutes: 10 }]);
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${statsQuery(0).sql}`).all(bind(statsQuery(0))).map((r) => r.detail).join(' ');
  assert.match(plan, /event_log_at_idx/);
});

test('adminRemoveQuery: 대기 항목을 지우고 층을 돌려줌, 없으면 빈 결과', () => {
  const db = createDb();
  get(db, joinQuery({ id: 'w1', locationId: LOC, nickname: '가', ownerHash: 'h' }, NOW));
  assert.deepEqual({ ...get(db, adminRemoveQuery('w1')) }, { id: 'w1', location_id: LOC });
  assert.equal(get(db, adminRemoveQuery('w1')), undefined);
});

test('CSV 셀 이스케이프: 쉼표, 따옴표, 개행, 수식 시작 문자', () => {
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell(5), '5');
  assert.equal(csvCell(-5), "'-5");
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('a\nb'), '"a\nb"');
  for (const lead of ['=1+1', '+1', '-1', '@SUM(A1)']) assert.equal(csvCell(lead), `'${lead}`);
  assert.equal(csvCell('=a,b'), '"\'=a,b"');
  assert.equal(CSV_HEADER, 'at_kst,kind,location_id,machine_id,minutes,prev_remaining_sec');
  assert.equal(csvLine({ at: Date.parse('2026-11-04T07:08:09+09:00'), kind: 'adjust', location_id: LOC, machine_id: WASHER, minutes: 10, prev_remaining_sec: -30 }), `2026-11-04 07:08:09,adjust,${LOC},${WASHER},10,'-30`);
  assert.equal(csvLine({ at: Date.parse('2026-11-04T07:08:09+09:00'), kind: 'waitlist_join', location_id: LOC, machine_id: null, minutes: null, prev_remaining_sec: null }), `2026-11-04 07:08:09,waitlist_join,${LOC},,,`);
});

test('CSV 범위: 기본 30일, to 포함, 최대 180일, 형식 오류', () => {
  const now = Date.parse('2026-11-04T10:00:00+09:00');
  const def = parseCsvRange(null, null, now);
  assert.deepEqual({ from: def.from, to: def.to }, { from: '2026-10-06', to: '2026-11-04' });
  assert.equal(def.toAt, Date.parse('2026-11-05T00:00:00+09:00'));
  assert.equal(def.fromAt, Date.parse('2026-10-06T00:00:00+09:00'));
  const one = parseCsvRange('2026-11-04', '2026-11-04', now);
  assert.equal(one.toAt - one.fromAt, DAY_MS);
  assert.equal(parseCsvRange('2026-05-09', '2026-11-04', now).ok, true, '180일');
  assert.equal(parseCsvRange('2026-05-08', '2026-11-04', now).ok, false, '181일');
  assert.equal(parseCsvRange('2026-11-05', '2026-11-04', now).ok, false);
  for (const bad of ['2026-13-01', '11/04/2026', 'abc', '2026-02-30']) assert.equal(parseCsvRange(bad, '2026-11-04', now).ok, false, bad);
  const db = createDb();
  run(db, eventInsert({ at: one.fromAt, kind: 'start', locationId: LOC, machineId: WASHER }));
  run(db, eventInsert({ at: one.toAt - 1, kind: 'clear', locationId: LOC, machineId: WASHER }));
  run(db, eventInsert({ at: one.toAt, kind: 'start', locationId: LOC, machineId: WASHER }));
  assert.equal(all(db, csvQuery(one.fromAt, one.toAt)).length, 2);
});

test('점검 안내 문구 상수', () => {
  assert.match(SERVICE_MESSAGE, /점검 중인 기기예요/);
});
