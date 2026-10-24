import { test } from 'node:test';
import assert from 'node:assert/strict';

// 로컬 시험 서버만 변경하며, UI 검증 중인 washer-1은 읽기만 합니다.
const BASE = 'http://127.0.0.1:5173';
const TEST_IDS = ['washer-2', 'dryer-1'];

async function request(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    signal: AbortSignal.timeout(15_000),
  });
  return {
    status: response.status,
    headers: response.headers,
    body: await response.json(),
  };
}

async function read() {
  const response = await request('/api/machines');
  assert.equal(response.status, 200);
  return response;
}

function machine(snapshot, id) {
  const value = snapshot.machines.find((item) => item.id === id);
  assert.ok(value, `${id}가 응답에 있어야 합니다`);
  return value;
}

function post(id, command) {
  assert.ok(TEST_IDS.includes(id), '시험용 기기만 변경할 수 있습니다');
  return request(`/api/machines/${id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(command),
  });
}

function assertMinutes(snapshot, id, minutes) {
  const state = machine(snapshot, id);
  assert.equal(state.endsAt - state.updatedAt, minutes * 60_000);
  assert.ok(
    Math.abs(state.endsAt - snapshot.serverTime - minutes * 60_000) <= 2_000,
    `${id}의 종료 예정 시각이 서버 시각 기준 ${minutes}분이어야 합니다`,
  );
}

test('로컬 공유 API 통합 검증', async (t) => {
  try {
    await t.test('전체 GET과 시험 기기 미등록 상태', async () => {
      const response = await read();
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.ok(Number.isSafeInteger(response.body.serverTime));
      assert.deepEqual(
        response.body.machines.map((item) => item.id).sort(),
        ['dryer-1', 'washer-1', 'washer-2'],
      );
      for (const id of TEST_IDS) {
        assert.equal(machine(response.body, id).endsAt, null);
      }
    });

    await t.test('등록되지 않은 ID는 404', async () => {
      const response = await request('/api/machines/not-a-machine', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'start', expectedVersion: 0 }),
      });
      assert.equal(response.status, 404);
    });

    await t.test('잘못된 JSON은 400, Content-Type은 415이며 상태 유지', async () => {
      const before = machine((await read()).body, 'washer-2');
      const malformed = await request('/api/machines/washer-2', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{',
      });
      assert.equal(malformed.status, 400);
      const wrongType = await request('/api/machines/washer-2', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ action: 'start', expectedVersion: before.version }),
      });
      assert.equal(wrongType.status, 415);
      assert.deepEqual(machine((await read()).body, 'washer-2'), before);
    });

    await t.test('남은 시간 0분과 181분은 400이며 상태 유지', async () => {
      const before = machine((await read()).body, 'washer-2');
      for (const minutes of [0, 181]) {
        const response = await post('washer-2', {
          action: 'adjust', expectedVersion: before.version, minutes,
        });
        assert.equal(response.status, 400);
      }
      assert.deepEqual(machine((await read()).body, 'washer-2'), before);
    });

    await t.test('세탁 시작은 36분이며 건조기 상태 보존', async () => {
      const before = (await read()).body;
      const previous = machine(before, 'washer-2');
      const response = await post('washer-2', {
        action: 'start', expectedVersion: previous.version,
      });
      assert.equal(response.status, 200);
      assertMinutes(response.body, 'washer-2', 36);
      assert.equal(machine(response.body, 'washer-2').version, previous.version + 1);
      assert.deepEqual(machine(response.body, 'dryer-1'), machine(before, 'dryer-1'));
      assert.deepEqual(machine((await read()).body, 'washer-2'), machine(response.body, 'washer-2'));
    });

    await t.test('건조 시작은 45분이며 세탁기 상태 보존', async () => {
      const before = (await read()).body;
      const previous = machine(before, 'dryer-1');
      const response = await post('dryer-1', {
        action: 'start', expectedVersion: previous.version,
      });
      assert.equal(response.status, 200);
      assertMinutes(response.body, 'dryer-1', 45);
      assert.equal(machine(response.body, 'dryer-1').version, previous.version + 1);
      assert.deepEqual(machine(response.body, 'washer-2'), machine(before, 'washer-2'));
      assert.deepEqual(machine((await read()).body, 'dryer-1'), machine(response.body, 'dryer-1'));
    });

    await t.test('같은 버전의 중복 시작은 409이며 종료 시각 유지', async () => {
      const before = machine((await read()).body, 'washer-2');
      const response = await post('washer-2', {
        action: 'start', expectedVersion: before.version - 1,
      });
      assert.equal(response.status, 409);
      assert.deepEqual(machine((await read()).body, 'washer-2'), before);
    });

    await t.test('최신 버전이어도 가동 중 재시작은 409', async () => {
      const before = machine((await read()).body, 'dryer-1');
      const response = await post('dryer-1', {
        action: 'start', expectedVersion: before.version,
      });
      assert.equal(response.status, 409);
      assert.deepEqual(machine((await read()).body, 'dryer-1'), before);
    });

    await t.test('같은 버전의 동시 시간 수정은 하나만 반영하고 다른 기기 보존', async () => {
      const before = (await read()).body;
      const previous = machine(before, 'washer-2');
      const minutes = [12, 15];
      const responses = await Promise.all(minutes.map((value) => post('washer-2', {
        action: 'adjust', expectedVersion: previous.version, minutes: value,
      })));
      assert.deepEqual(responses.map((item) => item.status).sort(), [200, 409]);
      const winnerIndex = responses.findIndex((item) => item.status === 200);
      const winner = responses[winnerIndex].body;
      assertMinutes(winner, 'washer-2', minutes[winnerIndex]);
      assert.equal(machine(winner, 'washer-2').version, previous.version + 1);
      const after = (await read()).body;
      assert.deepEqual(machine(after, 'washer-2'), machine(winner, 'washer-2'));
      assert.deepEqual(machine(after, 'dryer-1'), machine(before, 'dryer-1'));
    });
  } finally {
    // 중간 검증 실패가 있어도 시험한 두 기기를 각각 정리합니다.
    const cleanupErrors = [];
    for (const id of TEST_IDS) {
      try {
        const before = machine((await read()).body, id);
        if (before.endsAt !== null) {
          const response = await post(id, { action: 'clear', expectedVersion: before.version });
          assert.equal(response.status, 200);
          assert.equal(machine(response.body, id).endsAt, null);
          assert.equal(machine(response.body, id).version, before.version + 1);
        }
        assert.equal(machine((await read()).body, id).endsAt, null);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    await t.test('시험 종료 후 두 기기의 등록 취소와 null 재조회', () => {
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors, '시험 기기 정리 실패');
    });
  }
});
