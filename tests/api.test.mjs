import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MACHINES } from '../lib/laundry.ts';

// 로컬 시험 서버에서 3생활관 여자 2층, 3층, 5층(건조기)의 지정 기기만 변경합니다.
const BASE = 'http://127.0.0.1:5173';
// 관리자 API 시험은 ADMIN_TOKEN 환경변수가 있을 때만 실행해요(토큰은 코드에 두지 않아요). preview 서버도 같은 값을 .dev.vars로 받아야 해요.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const REPORT_ID = 'h3-women-3-dryer-1';
const TEST_IDS = ['h3-women-2-washer-2', 'h3-women-2-dryer-1', 'h3-women-3-washer-2', 'h3-women-5-dryer-1'];

// 로컬 wrangler dev(workerd)는 가끔 요청 사이에 워커를 다시 띄우며 "restarted mid-request" 503을 돌려줘요(PR B 기준 코드에서도 재현). 코드 문제가 아니라 시험이 흔들리지 않도록 이 경우만 다시 보내요.
async function fetchRetry(url, options = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15_000) });
    if (response.status !== 503 || attempt >= 3) return response;
    if (!(await response.clone().text()).includes('restarted mid-request')) return response;
  }
}

async function request(path, options = {}) {
  const response = await fetchRetry(`${BASE}${path}`, options);
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
        MACHINES.map((item) => item.id).sort(),
      );
      for (const id of TEST_IDS) {
        assert.equal(machine(response.body, id).endsAt, null);
      }
    });

    await t.test('기존 ID와 미등록 생활관 또는 구역 또는 층은 404', async () => {
      for (const id of ['not-a-machine', 'washer-1', 'washer-2', 'dryer-1', 'h2-women-2-washer-1', 'h3-men-2-washer-1', 'h3-women-1-washer-1']) {
        const response = await request(`/api/machines/${id}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'start', expectedVersion: 0 }),
        });
        assert.equal(response.status, 404, `${id}는 미등록이어야 합니다`);
      }
    });

    await t.test('잘못된 JSON은 400, Content-Type은 415이며 상태 유지', async () => {
      const before = machine((await read()).body, 'h3-women-2-washer-2');
      const malformed = await request('/api/machines/h3-women-2-washer-2', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{',
      });
      assert.equal(malformed.status, 400);
      const wrongType = await request('/api/machines/h3-women-2-washer-2', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ action: 'start', expectedVersion: before.version }),
      });
      assert.equal(wrongType.status, 415);
      assert.deepEqual(machine((await read()).body, 'h3-women-2-washer-2'), before);
    });

    await t.test('남은 시간 0분과 181분은 400이며 상태 유지', async () => {
      const before = machine((await read()).body, 'h3-women-2-washer-2');
      for (const minutes of [0, 181]) {
        const response = await post('h3-women-2-washer-2', {
          action: 'adjust', expectedVersion: before.version, minutes,
        });
        assert.equal(response.status, 400);
      }
      assert.deepEqual(machine((await read()).body, 'h3-women-2-washer-2'), before);
    });

    await t.test('세탁 시작은 36분이며 건조기 상태 보존', async () => {
      const before = (await read()).body;
      const previous = machine(before, 'h3-women-2-washer-2');
      const response = await post('h3-women-2-washer-2', {
        action: 'start', expectedVersion: previous.version,
      });
      assert.equal(response.status, 200);
      assertMinutes(response.body, 'h3-women-2-washer-2', 36);
      assert.equal(machine(response.body, 'h3-women-2-washer-2').version, previous.version + 1);
      assert.deepEqual(machine(response.body, 'h3-women-2-dryer-1'), machine(before, 'h3-women-2-dryer-1'));
      assert.deepEqual(machine((await read()).body, 'h3-women-2-washer-2'), machine(response.body, 'h3-women-2-washer-2'));
    });

    await t.test('건조 시작은 45분이며 세탁기 상태 보존', async () => {
      const before = (await read()).body;
      const previous = machine(before, 'h3-women-2-dryer-1');
      const response = await post('h3-women-2-dryer-1', {
        action: 'start', expectedVersion: previous.version,
      });
      assert.equal(response.status, 200);
      assertMinutes(response.body, 'h3-women-2-dryer-1', 45);
      assert.equal(machine(response.body, 'h3-women-2-dryer-1').version, previous.version + 1);
      assert.deepEqual(machine(response.body, 'h3-women-2-washer-2'), machine(before, 'h3-women-2-washer-2'));
      assert.deepEqual(machine((await read()).body, 'h3-women-2-dryer-1'), machine(response.body, 'h3-women-2-dryer-1'));
    });

    await t.test('같은 버전의 중복 시작은 409이며 종료 시각 유지', async () => {
      const before = machine((await read()).body, 'h3-women-2-washer-2');
      const response = await post('h3-women-2-washer-2', {
        action: 'start', expectedVersion: before.version - 1,
      });
      assert.equal(response.status, 409);
      assert.deepEqual(machine((await read()).body, 'h3-women-2-washer-2'), before);
    });

    await t.test('다른 층의 같은 기기 번호를 시작해도 기존 층 상태 보존', async () => {
      const before = (await read()).body;
      const id = 'h3-women-3-washer-2';
      const previous = machine(before, id);
      const response = await post(id, { action: 'start', expectedVersion: previous.version });
      assert.equal(response.status, 200);
      assertMinutes(response.body, id, 36);
      assert.equal(machine(response.body, id).version, previous.version + 1);
      const after = (await read()).body;
      assert.deepEqual(machine(after, id), machine(response.body, id));
      assert.deepEqual(machine(after, 'h3-women-2-washer-2'), machine(before, 'h3-women-2-washer-2'));
      assert.deepEqual(machine(after, 'h3-women-2-dryer-1'), machine(before, 'h3-women-2-dryer-1'));
    });

    await t.test('최신 버전이어도 가동 중 재시작은 409', async () => {
      const before = machine((await read()).body, 'h3-women-2-dryer-1');
      const response = await post('h3-women-2-dryer-1', {
        action: 'start', expectedVersion: before.version,
      });
      assert.equal(response.status, 409);
      assert.deepEqual(machine((await read()).body, 'h3-women-2-dryer-1'), before);
    });

    await t.test('같은 버전의 동시 시간 수정은 하나만 반영하고 다른 기기 보존', async () => {
      const before = (await read()).body;
      const previous = machine(before, 'h3-women-2-washer-2');
      const minutes = [12, 15];
      const responses = await Promise.all(minutes.map((value) => post('h3-women-2-washer-2', {
        action: 'adjust', expectedVersion: previous.version, minutes: value,
      })));
      assert.deepEqual(responses.map((item) => item.status).sort(), [200, 409]);
      const winnerIndex = responses.findIndex((item) => item.status === 200);
      const winner = responses[winnerIndex].body;
      assertMinutes(winner, 'h3-women-2-washer-2', minutes[winnerIndex]);
      assert.equal(machine(winner, 'h3-women-2-washer-2').version, previous.version + 1);
      const after = (await read()).body;
      assert.deepEqual(machine(after, 'h3-women-2-washer-2'), machine(winner, 'h3-women-2-washer-2'));
      assert.deepEqual(machine(after, 'h3-women-2-dryer-1'), machine(before, 'h3-women-2-dryer-1'));
      assert.deepEqual(machine(after, 'h3-women-3-washer-2'), machine(before, 'h3-women-3-washer-2'));
    });
    await t.test('대기 명단 등록, 중복 거절, 취소', async () => {
      const nickname = `시험${Date.now() % 100000}`;
      const wait = (body) => request('/api/waitlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const joined = await wait({ action: 'join', locationId: 'h3-women-2', nickname });
      assert.equal(joined.status, 200);
      const { id, token } = joined.body.joined;
      try {
        const listed = (await read()).body.waitlist.find((entry) => entry.id === id);
        assert.equal(listed?.nickname, nickname);
        assert.ok(!JSON.stringify((await read()).body).includes(token));
        assert.equal((await wait({ action: 'join', locationId: 'h3-women-2', nickname })).status, 409);
        assert.equal((await wait({ action: 'leave', id, token: 'x'.repeat(40) })).status, 404);
      } finally {
        const left = await wait({ action: 'leave', id, token });
        assert.equal(left.status, 200);
      }
      assert.ok(!(await read()).body.waitlist.some((entry) => entry.id === id));
    });
    await t.test('건조기 시작과 함께 내 대기 항목을 서버가 정리하고, 다른 사람 토큰이면 유지', async () => {
      const dryerId = 'h3-women-5-dryer-1';
      const wait = (body) => request('/api/waitlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const suffix = Date.now() % 100000;
      const joined = await wait({ action: 'join', locationId: 'h3-women-5', nickname: `차례${suffix}` });
      assert.equal(joined.status, 200);
      const { id, token } = joined.body.joined;
      try {
        const adjustWithWaitlist = await post(dryerId, { action: 'adjust', minutes: 10, expectedVersion: machine((await read()).body, dryerId).version, waitlist: { id, token } });
        assert.equal(adjustWithWaitlist.status, 400);
        const wrong = await post(dryerId, { action: 'start', expectedVersion: machine((await read()).body, dryerId).version, waitlist: { id, token: 'y'.repeat(40) } });
        assert.equal(wrong.status, 200);
        assert.equal(wrong.body.waitlistRemoved, undefined);
        assert.ok(wrong.body.waitlist.some((entry) => entry.id === id));
        const cleared = await post(dryerId, { action: 'clear', expectedVersion: machine(wrong.body, dryerId).version });
        assert.equal(cleared.status, 200);
        const stale = await post(dryerId, { action: 'start', expectedVersion: machine(cleared.body, dryerId).version - 1, waitlist: { id, token } });
        assert.equal(stale.status, 409);
        assert.ok((await read()).body.waitlist.some((entry) => entry.id === id), '실패한 시작은 대기 항목을 지우면 안 됩니다');
        const started = await post(dryerId, { action: 'start', expectedVersion: machine(cleared.body, dryerId).version, waitlist: { id, token } });
        assert.equal(started.status, 200);
        assert.equal(started.body.waitlistRemoved, true);
        assertMinutes(started.body, dryerId, 45);
        assert.ok(!started.body.waitlist.some((entry) => entry.id === id));
        assert.ok(!(await read()).body.waitlist.some((entry) => entry.id === id));
      } finally {
        await wait({ action: 'leave', id, token });
      }
    });
    await t.test('관리자 API는 토큰이 없거나 틀리면 401', async () => {
      const paths = ['/api/admin/overview', '/api/admin/events.csv'];
      for (const path of paths) {
        const none = await fetchRetry(`${BASE}${path}`);
        assert.equal(none.status, 401, path);
        assert.equal(none.headers.get('cache-control'), 'no-store');
        const wrong = await fetchRetry(`${BASE}${path}`, { headers: { authorization: 'Bearer wrong-token-wrong-token-wrong' } });
        assert.equal(wrong.status, 401, `${path} 틀린 토큰`);
      }
      for (const path of ['/api/admin/machines/h3-women-2-washer-2', '/api/admin/waitlist']) {
        const post = await fetchRetry(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'reset' }) });
        assert.equal(post.status, 401, `${path} POST`);
      }
    });
    // 이 시험은 로컬 서버의 event_log에 고장 신고 3건을 남겨요(운영 서버가 아니므로 허용). 같은 기기는 10분에 3건까지라 반복 실행하면 처음부터 429가 날 수 있어요.
    await t.test('고장 신고는 기기당 10분에 3건까지, 넘으면 429', async () => {
      const report = () => request(`/api/machines/${REPORT_ID}/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const statuses = [];
      for (let i = 0; i < 4; i += 1) statuses.push((await report()).status);
      // 같은 기기에 10분 안에 이미 신고가 남아 있으면(이 시험을 연달아 돌린 경우) 200이 3번보다 적고 429가 먼저 나와요. 어느 경우든 200은 3번을 넘지 않고 마지막은 429예요.
      assert.ok(statuses.filter((status) => status === 200).length <= 3, JSON.stringify(statuses));
      assert.equal(statuses.at(-1), 429, JSON.stringify(statuses));
      assert.ok(statuses.every((status) => status === 200 || status === 429), JSON.stringify(statuses));
      assert.equal((await request('/api/machines/not-a-machine/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
      assert.equal((await request(`/api/machines/${REPORT_ID}/report`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415);
    });
    await t.test('ADMIN_TOKEN이 있으면: 점검 on → 일반 시작 409 → 대기 등록 409 → 점검 off, 초기화, 통계, CSV', { skip: ADMIN_TOKEN ? false : 'ADMIN_TOKEN 환경변수가 없어 관리자 시험을 건너뛰어요' }, async () => {
      const admin = (path, options = {}) => fetchRetry(`${BASE}${path}`, { ...options, headers: { ...options.headers, authorization: `Bearer ${ADMIN_TOKEN}`, ...(options.body ? { 'content-type': 'application/json' } : {}) } });
      const adminPost = async (path, body) => { const response = await admin(path, { method: 'POST', body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
      const id = 'h3-women-5-dryer-1';
      const wait = (body) => request('/api/waitlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      let waitlistId;
      try {
        const overview = await admin('/api/admin/overview');
        assert.equal(overview.status, 200);
        assert.equal(overview.headers.get('cache-control'), 'no-store');
        const data = await overview.json();
        assert.equal(data.machines.length, MACHINES.length);
        assert.ok(['today', 'week', 'all'].every((key) => data.stats[key] && typeof data.stats[key].counts === 'object'));
        assert.equal(data.stats.hourly7d.length, 24);
        const light = await (await admin('/api/admin/overview?stats=0')).json();
        assert.equal(light.machines.length, MACHINES.length);
        assert.ok(Array.isArray(light.waitlist));
        assert.equal('stats' in light || 'accuracy' in light, false, 'stats=0에는 통계가 없어요');
        assert.ok(data.machines.find((item) => item.id === REPORT_ID).reports24h >= 3);
        assert.equal((await adminPost(`/api/admin/machines/${id}`, { action: 'service', on: true, note: 'x'.repeat(41) })).status, 400);
        const on = await adminPost(`/api/admin/machines/${id}`, { action: 'service', on: true, note: '  시험 점검  ' });
        assert.equal(on.status, 200);
        assert.deepEqual([machine(on.body, id).outOfService, machine(on.body, id).serviceNote], [true, '시험 점검']);
        const snapshot = (await read()).body;
        assert.deepEqual([machine(snapshot, id).outOfService, machine(snapshot, id).serviceNote], [true, '시험 점검']);
        const blocked = await post(id, { action: 'start', expectedVersion: machine(snapshot, id).version });
        assert.equal(blocked.status, 409);
        assert.match(blocked.body.error, /점검 중인 기기예요/);
        assert.equal(blocked.body.reason, 'service');
        const staleVersion = await post(id, { action: 'start', expectedVersion: 0 });
        assert.equal(staleVersion.status, 409);
        const joined = await wait({ action: 'join', locationId: 'h3-women-5', nickname: `점검${Date.now() % 100000}` });
        assert.equal(joined.status, 409);
        assert.match(joined.body.error, /건조기 점검 중에는 대기 등록을 받지 않아요/);
        const off = await adminPost(`/api/admin/machines/${id}`, { action: 'service', on: false });
        assert.equal(off.status, 200);
        assert.deepEqual([machine(off.body, id).outOfService, machine(off.body, id).serviceNote], [false, null]);
        const started = await post(id, { action: 'start', expectedVersion: machine(off.body, id).version });
        assert.equal(started.status, 200);
        const reset = await adminPost(`/api/admin/machines/${id}`, { action: 'reset' });
        assert.equal(reset.status, 200);
        assert.equal(machine(reset.body, id).endsAt, null);
        const entry = await wait({ action: 'join', locationId: 'h3-women-5', nickname: `삭제${Date.now() % 100000}` });
        assert.equal(entry.status, 200);
        waitlistId = entry.body.joined.id;
        const removed = await adminPost('/api/admin/waitlist', { action: 'remove', id: waitlistId });
        assert.equal(removed.status, 200);
        assert.ok(!removed.body.waitlist.some((item) => item.id === waitlistId));
        assert.equal((await adminPost('/api/admin/waitlist', { action: 'remove', id: waitlistId })).status, 404);
        waitlistId = undefined;
        const after = await (await admin('/api/admin/overview')).json();
        for (const kind of ['service_on', 'service_off', 'admin_reset', 'admin_remove']) assert.ok(after.stats.all.counts[kind] >= 1, kind);
        const csv = await admin('/api/admin/events.csv');
        assert.equal(csv.status, 200);
        assert.match(csv.headers.get('content-type'), /^text\/csv; charset=utf-8/);
        assert.match(csv.headers.get('content-disposition'), /^attachment; filename="tmi-laundry-events-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv"$/);
        // text()는 앞의 BOM을 지워 버리므로 바이트로 확인해요.
        const bytes = new Uint8Array(await csv.arrayBuffer());
        assert.deepEqual([...bytes.slice(0, 3)], [0xEF, 0xBB, 0xBF], 'UTF-8 BOM');
        const text = new TextDecoder().decode(bytes);
        assert.ok(text.startsWith('at_kst,kind,location_id,machine_id,minutes,prev_remaining_sec\r\n'));
        assert.ok(text.includes(',service_on,h3-women-5,'));
        assert.equal((await admin('/api/admin/events.csv?from=2026-13-01')).status, 400);
        assert.equal((await admin('/api/admin/events.csv?from=2020-01-01&to=2026-01-01')).status, 400);
      } finally {
        await adminPost(`/api/admin/machines/${id}`, { action: 'service', on: false }).catch(() => {});
        if (waitlistId) await adminPost('/api/admin/waitlist', { action: 'remove', id: waitlistId }).catch(() => {});
      }
    });
  } finally {
    // 중간 검증 실패가 있어도 시험한 기기를 각각 정리합니다.
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
    await t.test('시험 종료 후 네 기기의 등록 취소와 null 재조회', () => {
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors, '시험 기기 정리 실패');
    });
  }
});
