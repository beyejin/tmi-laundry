import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareAvailableFirst, countAvailable, isAvailableNow, orderMachines } from '../app/proto/empty-first.ts';

test('등록이 없는 기기만 빈 기기이고 예상 종료는 빈 기기가 아님', () => {
  assert.equal(isAvailableNow({ status: 'unknown', remainingSeconds: null }), true);
  assert.equal(isAvailableNow({ status: 'finished', remainingSeconds: 0 }), false);
  assert.equal(isAvailableNow({ status: 'running', remainingSeconds: 60 }), false);
});

test('빈 기기, 곧 끝나는 순, 사용 중, 예상 종료 순으로 정렬', () => {
  const machines = [
    { id: 'washer-1', type: 'washer', status: 'running', remainingSeconds: 1800 },
    { id: 'washer-2', type: 'washer', status: 'running', remainingSeconds: 240 },
    { id: 'dryer-1', type: 'dryer', status: 'unknown', remainingSeconds: null },
    { id: 'washer-3', type: 'washer', status: 'finished', remainingSeconds: 0 },
  ];
  assert.deepEqual(orderMachines(machines, 'available').map((machine) => machine.id), ['dryer-1', 'washer-2', 'washer-1', 'washer-3']);
  assert.deepEqual(orderMachines(machines, 'number').map((machine) => machine.id), ['washer-1', 'washer-2', 'dryer-1', 'washer-3']);
});

test('같은 상태에서는 기기 번호순을 유지', () => {
  const machines = [
    { id: 'a', status: 'unknown', remainingSeconds: null },
    { id: 'b', status: 'finished', remainingSeconds: 0 },
    { id: 'c', status: 'unknown', remainingSeconds: null },
    { id: 'd', status: 'running', remainingSeconds: 600 },
    { id: 'e', status: 'running', remainingSeconds: 600 },
    { id: 'f', status: 'finished', remainingSeconds: 0 },
  ];
  assert.deepEqual([...machines].sort(compareAvailableFirst).map((machine) => machine.id), ['a', 'c', 'd', 'e', 'b', 'f']);
});

test('빈 세탁기와 빈 건조기를 따로 셈', () => {
  assert.deepEqual(countAvailable([
    { type: 'washer', status: 'unknown', remainingSeconds: null },
    { type: 'washer', status: 'running', remainingSeconds: 100 },
    { type: 'dryer', status: 'unknown', remainingSeconds: null },
    { type: 'dryer', status: 'finished', remainingSeconds: 0 },
  ]), { washer: 1, dryer: 1 });
});
