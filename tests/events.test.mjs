import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './schema.mjs';
import { EVENT_KINDS, EVENT_RETENTION_MS, eventCleanupQuery, eventInsert } from '../lib/events.ts';

const NOW = 1_800_000_000_000;
const bind = (q) => Object.fromEntries(q.values.map((value, index) => [String(index + 1), value]));

test('이벤트 종류 상수', () => {
  assert.deepEqual([...EVENT_KINDS], ['start', 'adjust', 'clear', 'waitlist_join', 'waitlist_leave', 'waitlist_turn']);
  assert.equal(new Set(EVENT_KINDS).size, EVENT_KINDS.length);
});

test('eventInsert: 기록하고 읽으면 같은 값, 생략한 값은 NULL', () => {
  const db = createDb();
  for (const q of [
    eventInsert({ kind: 'adjust', locationId: 'h3-women-2', machineId: 'h3-women-2-washer-1', minutes: 12, prevRemainingSec: -30 }, NOW),
    eventInsert({ kind: 'waitlist_join', locationId: 'h3-women-3' }, NOW + 1),
  ]) db.prepare(q.sql).run(bind(q));
  const rows = db.prepare('SELECT at, kind, location_id, machine_id, minutes, prev_remaining_sec FROM event_log ORDER BY id').all().map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    { at: NOW, kind: 'adjust', location_id: 'h3-women-2', machine_id: 'h3-women-2-washer-1', minutes: 12, prev_remaining_sec: -30 },
    { at: NOW + 1, kind: 'waitlist_join', location_id: 'h3-women-3', machine_id: null, minutes: null, prev_remaining_sec: null },
  ]);
  db.close();
});

test('event_log에는 개인 식별 열이 없음', () => {
  const db = createDb();
  const columns = db.prepare("SELECT name FROM pragma_table_info('event_log')").all().map((row) => row.name);
  assert.deepEqual(columns, ['id', 'at', 'kind', 'location_id', 'machine_id', 'minutes', 'prev_remaining_sec']);
  db.close();
});

test('eventCleanup: 120일이 정확히 지난 기록부터 삭제', () => {
  const db = createDb();
  for (const at of [NOW - EVENT_RETENTION_MS - 1, NOW - EVENT_RETENTION_MS, NOW - EVENT_RETENTION_MS + 1, NOW]) {
    const q = eventInsert({ kind: 'start', locationId: 'h3-women-2' }, at);
    db.prepare(q.sql).run(bind(q));
  }
  const cleanup = eventCleanupQuery(NOW);
  db.prepare(cleanup.sql).run(bind(cleanup));
  assert.deepEqual(db.prepare('SELECT at FROM event_log ORDER BY at').all().map((row) => row.at - NOW), [-EVENT_RETENTION_MS + 1, 0]);
  db.close();
});
