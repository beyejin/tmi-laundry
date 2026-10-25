import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { BUILDINGS, WINGS, LOCATIONS, MACHINES, findLocation, findMachine, mutationQuery, parseCommand, stateSnapshot } from '../lib/laundry.ts';

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE machine_state (id TEXT PRIMARY KEY, ends_at INTEGER, updated_at INTEGER NOT NULL, version INTEGER NOT NULL)');
  return {
    db,
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

test('확인된 위치만 등록하고 생활관과 구역과 층을 기기 ID에 포함', () => {
  assert.deepEqual(BUILDINGS, [2, 3]);
  assert.deepEqual(WINGS.map((wing) => wing.id), ['women', 'men']);
  assert.deepEqual(LOCATIONS.map((location) => location.id), ['h3-women-2', 'h3-women-3', 'h3-women-4', 'h3-women-5']);
  assert.equal(MACHINES.length, 12);
  assert.equal(new Set(MACHINES.map((machine) => machine.id)).size, 12);
  for (const location of LOCATIONS) {
    const machines = MACHINES.filter((machine) => machine.locationId === location.id);
    assert.equal(findLocation(location.id), location);
    assert.deepEqual(machines.map((machine) => machine.id), [`${location.id}-washer-1`, `${location.id}-washer-2`, `${location.id}-dryer-1`]);
    assert.deepEqual(machines.map((machine) => machine.defaultMinutes), [36, 36, 45]);
  }
  for (const id of ['h2-women-2', 'h2-men-2', 'h3-men-2', 'h3-women-1']) assert.equal(findLocation(id), undefined);
});

test('기존 ID와 확인되지 않은 구역 기기를 새 위치로 매핑하지 않음', () => {
  for (const id of ['washer-1', 'washer-2', 'dryer-1', 'h2-women-2-washer-1', 'h3-men-2-washer-1', 'h3-women-1-washer-1']) {
    assert.equal(findMachine(id), undefined);
    assert.throws(() => mutationQuery(id, { action: 'start', expectedVersion: 0 }, 1000), /등록되지 않은 기기/);
    assert.throws(() => mutationQuery(id, { action: 'clear', expectedVersion: 1 }, 1000), /등록되지 않은 기기/);
  }
});

test('기존 위치 미지정 DB 기록을 보존하면서 새 위치 현황에서 제외', () => {
  const s = setup();
  s.db.prepare('INSERT INTO machine_state VALUES (?, ?, ?, ?)').run('washer-1', 999000, 1000, 7);
  s.db.prepare('INSERT INTO machine_state VALUES (?, ?, ?, ?)').run('h3-men-2-washer-1', 888000, 1000, 4);
  const before = s.db.prepare('SELECT * FROM machine_state ORDER BY id').all();
  const state = s.read(2000);
  assert.equal(state.machines.length, 12);
  assert.ok(state.machines.every((machine) => machine.endsAt === null && machine.version === 0));
  assert.deepEqual(s.db.prepare('SELECT * FROM machine_state ORDER BY id').all(), before);
  s.close();
});

test('미등록 기기는 사용 가능으로 단정하지 않고 null로 제공', () => {
  const state = stateSnapshot([], 1000);
  assert.equal(state.machines.length, 12);
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
  const first = s.write('h3-women-2-washer-1', { action: 'start', expectedVersion: 0 }, 1000);
  assert.equal(s.write('h3-women-2-washer-1', { action: 'start', expectedVersion: 0 }, 2000), undefined);
  assert.equal(s.write('h3-women-2-washer-1', { action: 'start', expectedVersion: 1 }, 3000), undefined);
  assert.equal(s.read(4000).machines[0].endsAt, first.ends_at);
  s.close();
});

test('동시 수정은 하나만 반영하고 다른 기기는 유지', () => {
  const s = setup();
  s.write('h3-women-2-washer-1', { action: 'start', expectedVersion: 0 }, 1000);
  s.write('h3-women-2-dryer-1', { action: 'start', expectedVersion: 0 }, 1000);
  assert.equal(s.write('h3-women-2-washer-1', { action: 'adjust', expectedVersion: 1, minutes: 12 }, 2000).ends_at, 722000);
  assert.equal(s.write('h3-women-2-washer-1', { action: 'adjust', expectedVersion: 1, minutes: 15 }, 2000), undefined);
  const rows = s.read(2000).machines;
  assert.equal(rows[0].version, 2);
  assert.equal(rows[2].endsAt, 2701000);
  s.close();
});

test('다른 층의 같은 기기 번호는 종료 시각과 버전이 독립적', () => {
  const s = setup();
  const firstId = 'h3-women-2-washer-1';
  const otherId = 'h3-women-3-washer-1';
  s.write(firstId, { action: 'start', expectedVersion: 0 }, 1000);
  s.write(otherId, { action: 'start', expectedVersion: 0 }, 2000);
  const otherBefore = s.read(3000).machines.find((machine) => machine.id === otherId);
  s.write(firstId, { action: 'adjust', expectedVersion: 1, minutes: 12 }, 4000);
  assert.equal(s.write(firstId, { action: 'adjust', expectedVersion: 1, minutes: 15 }, 5000), undefined);
  assert.deepEqual(s.read(6000).machines.find((machine) => machine.id === otherId), otherBefore);
  assert.equal(s.read(6000).machines.find((machine) => machine.id === firstId).version, 2);
  s.write(firstId, { action: 'clear', expectedVersion: 2 }, 7000);
  assert.deepEqual(s.read(8000).machines.find((machine) => machine.id === otherId), otherBefore);
  assert.equal(s.read(8000).machines.find((machine) => machine.id === firstId).endsAt, null);
  s.close();
});

test('예상 종료 시각을 보존하며 종료 후 새 사용을 등록할 수 있음', () => {
  const s = setup();
  s.write('h3-women-2-dryer-1', { action: 'adjust', expectedVersion: 0, minutes: 1 }, 1000);
  assert.equal(s.read(62000).machines[2].endsAt, 61000);
  assert.equal(s.write('h3-women-2-dryer-1', { action: 'start', expectedVersion: 1 }, 62000).ends_at, 2762000);
  s.close();
});

test('잘못 등록한 시간은 취소 후 미확인 상태로 돌아감', () => {
  const s = setup();
  s.write('h3-women-2-washer-2', { action: 'start', expectedVersion: 0 }, 1000);
  s.write('h3-women-2-washer-2', { action: 'clear', expectedVersion: 1 }, 2000);
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
