import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MACHINES, mutationQuery, parseCommand, stateSnapshot } from '../lib/laundry.ts';

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE machine_state (id TEXT PRIMARY KEY, ends_at INTEGER, updated_at INTEGER NOT NULL, version INTEGER NOT NULL)');
  return {
    read: (now) => stateSnapshot(db.prepare('SELECT * FROM machine_state').all(), now),
    write: (id, command, now) => {
      const q = mutationQuery(id, command, now);
      const statement = db.prepare(q.sql);
      const bindings = Object.fromEntries(q.values.map((value, index) => [String(index + 1), value]));
      return statement.get(bindings);
    },
    close: () => db.close(),
  };
}

test('미등록 기기는 사용 가능으로 단정하지 않고 null로 제공', () => {
  const state = stateSnapshot([], 1000);
  assert.equal(state.machines.length, 3);
  assert.ok(state.machines.every((m) => m.endsAt === null && m.version === 0));
});

test('세탁 36분과 건조 45분을 서버 시각 기준으로 저장하고 재조회해도 유지', () => {
  const store = setup();
  for (const m of MACHINES) {
    const row = store.write(m.id, { action: 'start', expectedVersion: 0 }, 1000);
    assert.equal(row.ends_at, 1000 + m.defaultMinutes * 60_000);
  }
  assert.equal(store.read(61_000).machines[0].endsAt, 2_161_000);
  store.close();
});

test('동일 버전 중복 등록과 가동 중 재시작은 종료 시각을 미루지 않음', () => {
  const s = setup();
  const first = s.write('washer-1', { action: 'start', expectedVersion: 0 }, 1000);
  assert.equal(s.write('washer-1', { action: 'start', expectedVersion: 0 }, 2000), undefined);
  assert.equal(s.write('washer-1', { action: 'start', expectedVersion: 1 }, 3000), undefined);
  assert.equal(s.read(4000).machines[0].endsAt, first.ends_at);
  s.close();
});

test('동시 수정은 하나만 반영하고 다른 기기는 유지', () => {
  const s = setup();
  s.write('washer-1', { action: 'start', expectedVersion: 0 }, 1000);
  s.write('dryer-1', { action: 'start', expectedVersion: 0 }, 1000);
  assert.equal(s.write('washer-1', { action: 'adjust', expectedVersion: 1, minutes: 12 }, 2000).ends_at, 722000);
  assert.equal(s.write('washer-1', { action: 'adjust', expectedVersion: 1, minutes: 15 }, 2000), undefined);
  const rows = s.read(2000).machines;
  assert.equal(rows[0].version, 2);
  assert.equal(rows[2].endsAt, 2701000);
  s.close();
});

test('예상 종료 시각을 보존하며 종료 후 새 사용을 등록할 수 있음', () => {
  const s = setup();
  s.write('dryer-1', { action: 'adjust', expectedVersion: 0, minutes: 1 }, 1000);
  assert.equal(s.read(62000).machines[2].endsAt, 61000);
  assert.equal(s.write('dryer-1', { action: 'start', expectedVersion: 1 }, 62000).ends_at, 2762000);
  s.close();
});

test('잘못 등록한 시간은 취소 후 미확인 상태로 돌아감', () => {
  const s = setup();
  s.write('washer-2', { action: 'start', expectedVersion: 0 }, 1000);
  s.write('washer-2', { action: 'clear', expectedVersion: 1 }, 2000);
  const state = s.read(2000).machines[1];
  assert.equal(state.endsAt, null);
  assert.equal(state.version, 2);
  s.close();
});

test('잘못된 시간과 버전을 거부', () => {
  for (const minutes of [0, -1, 181, 1.5, '12', null]) assert.equal(parseCommand({ action: 'adjust', expectedVersion: 0, minutes }), null);
  for (const expectedVersion of [-1, 0.5, '1', null]) assert.equal(parseCommand({ action: 'start', expectedVersion }), null);
  assert.equal(parseCommand(null), null);
  assert.equal(parseCommand({ action: 'unknown', expectedVersion: 0 }), null);
  assert.deepEqual(parseCommand({ action: 'adjust', expectedVersion: 0, minutes: 180 }), { action: 'adjust', expectedVersion: 0, minutes: 180 });
});
