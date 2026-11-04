import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, createHash } from 'node:crypto';

// 이 테스트 전용 로컬 Worker와 격리 DB만 사용합니다. 원격 URL과 기존 .wrangler/state는 사용하지 않습니다.
const BASE = 'http://127.0.0.1:5173';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PERSIST = '.wrangler/queue-test';
const USERS = ['e2e-owner', 'e2e-next', 'e2e-other', 'e2e-admin', 'e2e-no-push'];
const TOKENS = Object.fromEntries(USERS.map((id) => [id, randomBytes(32).toString('base64url')]));
const MACHINE = 'h3-women-2-washer-1';
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const userList = USERS.map(quote).join(',');
assert.equal(new URL(BASE).hostname, '127.0.0.1');
assert.equal(new URL(BASE).port, '5173');
assert.equal(resolve(ROOT, PERSIST), resolve(ROOT, '.wrangler/queue-test'));

function sql(source) {
  const directory = mkdtempSync(join(tmpdir(), 'tmi-queue-api-'));
  const file = join(directory, 'fixture.sql');
  try {
    writeFileSync(file, source, { mode: 0o600 });
    const output = execFileSync('npx', ['--no-install', 'wrangler', 'd1', 'execute', 'DB', '--local', '--persist-to', PERSIST, '--file', file, '--json'], {
      cwd: ROOT, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(output).flatMap((result) => result.results ?? []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

function resetFixture() {
  sql(`DELETE FROM queue_requests; DELETE FROM queue_records; DELETE FROM queue_meta;
    DELETE FROM push_subscriptions WHERE user_id IN (${userList});
    DELETE FROM auth_sessions WHERE user_id IN (${userList});
    DELETE FROM tmi_users WHERE id IN (${userList});`);
}

function seedFixture() {
  const now = Date.now();
  const statements = USERS.flatMap((id) => [
    `INSERT INTO tmi_users VALUES (${quote(id)},${quote(`${id}@gachon.ac.kr`)},${now},${now});`,
    `INSERT INTO auth_sessions VALUES (${quote(createHash('sha256').update(TOKENS[id]).digest('hex'))},${quote(id)},${now + 3600000});`,
    ...(id === 'e2e-no-push' ? [] : [
      // 잘못된 fixture 암호화 키이므로 실제 외부 Push는 발송할 수 없습니다.
      `INSERT INTO push_subscriptions(endpoint,user_id,p256dh,auth,active,updated_at) VALUES (${quote(`https://fcm.googleapis.com/fcm/send/${id}`)},${quote(id)},'invalid-e2e-key','invalid-e2e-auth',1,${now});`,
    ]),
  ]);
  sql(statements.join('\n'));
}

async function request(path, { user, headers = {}, ...options } = {}) {
  assert.ok(path.startsWith('/') && !path.startsWith('//'));
  const response = await fetch(`${BASE}${path}`, {
    ...options, headers: { ...(user ? { Cookie: `tmi_session=${TOKENS[user]}` } : {}), ...headers },
    signal: AbortSignal.timeout(15_000), redirect: 'error',
  });
  const text = await response.text();
  assert.match(response.headers.get('content-type') ?? '', /application\/json/, `${path}: ${response.status} ${text.slice(0, 200)}`);
  return { status: response.status, headers: response.headers, body: JSON.parse(text) };
}

function command(user, value, options = {}) {
  return request('/api/queue', { user, method: 'POST', headers: { Origin: BASE, 'Content-Type': 'application/json', ...options.headers },
    body: JSON.stringify({ requestId: randomUUID(), ...value }), ...Object.fromEntries(Object.entries(options).filter(([key]) => key !== 'headers')) });
}

async function snapshot(user) {
  const response = await request('/api/queue', { user });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.enabled, true, 'QUEUE_ENABLED=true인 격리 로컬 서버가 필요합니다.');
  return response.body;
}

function activeTickets(state, type) {
  return state.tickets.filter((ticket) => (!type || ticket.type === type) && !['cancelled', 'expired', 'completed'].includes(ticket.state));
}

function ownRun(state, runId) {
  const run = state.runs.find((value) => value.id === runId);
  assert.ok(run, `사용 기록 ${runId}가 있어야 합니다.`);
  return run;
}

function assertPrivate(state) {
  assert.deepEqual(state.tickets, []);
  assert.deepEqual(state.runs, []);
  assert.deepEqual(state.reports, []);
  const json = JSON.stringify(state);
  for (const user of USERS) assert.equal(json.includes(user), false);
  assert.equal(json.includes('@gachon.ac.kr'), false);
  for (const key of ['email', 'userId', 'ownerId', 'reporterId']) assert.equal(json.includes(`"${key}"`), false);
}

test('격리 로컬 Worker에서 학교 계정 대기제 통합 검증', { timeout: 180_000 }, async (t) => {
  const legacyBefore = sql('SELECT id, ends_at, updated_at, version FROM machine_state ORDER BY id;');
  resetFixture();
  seedFixture();
  let runId, nextTicketId, nextSequence, oldCallId, reportId, nextRunId;
  try {
    // DB가 다른 서버를 가리키면 이 확인에서 멈춰서 변경 API를 호출하지 않습니다.
    const owner = await request('/api/auth/me', { user: 'e2e-owner' });
    assert.equal(owner.status, 200);
    assert.equal(owner.body.user?.id, 'e2e-owner', '.wrangler/queue-test를 사용하는 서버인지 확인해 주세요.');
    const admin = await request('/api/auth/me', { user: 'e2e-admin' });
    assert.equal(admin.body.user?.isAdmin, true, 'ADMIN_GOOGLE_SUBS=e2e-admin 설정이 필요합니다.');

    await t.test('미로그인, Origin 누락과 위조, 입력 형식 및 알림 미등록 차단', async () => {
      assert.equal((await command(undefined, { action: 'join', type: 'washer' })).status, 401);
      assert.equal((await request('/api/queue', { user: 'e2e-owner', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID(), action: 'join', type: 'washer' }) })).status, 403);
      assert.equal((await command('e2e-owner', { action: 'join', type: 'washer' }, { headers: { Origin: 'https://attacker.example' } })).status, 403);
      assert.equal((await command('e2e-owner', { action: 'join', type: 'washer' }, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
      assert.equal((await request('/api/queue', { user: 'e2e-owner', method: 'POST', headers: { Origin: BASE, 'Content-Type': 'application/json' }, body: '{' })).status, 400);
      assert.equal((await command('e2e-no-push', { action: 'join', type: 'washer' })).status, 409);
    });

    await t.test('공개 현황은 시험 기기 12대만 표시하고 사용자 정보는 제외', async () => {
      const state = await snapshot();
      assert.equal(state.machines.length, 12);
      assert.equal(state.machines.filter((machine) => machine.type === 'washer').length, 8);
      assert.equal(state.machines.filter((machine) => machine.type === 'dryer').length, 4);
      assertPrivate(state);
      assert.equal((await request('/api/queue/admin', { user: 'e2e-other' })).status, 403);
      assert.equal((await request('/api/queue/admin', { user: 'e2e-admin' })).status, 200);
    });

    await t.test('시험 구역 익명 변경은 차단하고 기존 구역은 버전 검사까지 허용', async () => {
      const options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start', expectedVersion: Number.MAX_SAFE_INTEGER }) };
      assert.equal((await request(`/api/machines/${MACHINE}`, options)).status, 403);
      assert.equal((await request('/api/machines/h2-men-1-washer-1', options)).status, 409);
    });

    await t.test('운영자만 접수를 중단하고 재개할 수 있음', async () => {
      assert.equal((await command('e2e-other', { action: 'pause' })).status, 403);
      const paused = await command('e2e-admin', { action: 'pause' });
      assert.equal(paused.status, 200);
      assert.equal(paused.body.paused, true);
      assert.equal((await command('e2e-owner', { action: 'join', type: 'washer' })).status, 409);
      const resumed = await command('e2e-admin', { action: 'resume' });
      assert.equal(resumed.status, 200);
      assert.equal(resumed.body.paused, false);
    });

    await t.test('건조 준비 전 호출을 건너뛰고 준비 완료와 취소를 처리', async () => {
      const joined = await command('e2e-other', { action: 'join', type: 'dryer' });
      assert.equal(joined.status, 200);
      const ticket = activeTickets(joined.body, 'dryer')[0];
      assert.equal(ticket.state, 'preparing');
      const ready = await command('e2e-other', { action: 'ready', ticketId: ticket.id });
      assert.equal(ready.status, 200);
      assert.equal(activeTickets(ready.body, 'dryer')[0].state, 'waiting');
      assert.equal(activeTickets(ready.body, 'dryer')[0].sequence, ticket.sequence);
      assert.equal((await command('e2e-other', { action: 'cancel', ticketId: ticket.id })).status, 200);
    });

    await t.test('동시 등록도 종류별 2개 한도를 지키고 취소하면 한도를 반환', async () => {
      const attempts = await Promise.all(Array.from({ length: 3 }, () => command('e2e-other', { action: 'join', type: 'washer' })));
      assert.deepEqual(attempts.map((result) => result.status).sort(), [200, 200, 409]);
      const state = await snapshot('e2e-other');
      assert.equal(activeTickets(state, 'washer').length, 2);
      for (const ticket of activeTickets(state, 'washer')) assert.equal((await command('e2e-other', { action: 'cancel', ticketId: ticket.id })).status, 200);
      assert.equal(activeTickets(await snapshot('e2e-other')).length, 0);
    });

    await t.test('같은 요청 재전송은 중복 표를 만들지 않고 유효한 호출의 본인만 시작', async () => {
      const requestId = randomUUID();
      const joined = await command('e2e-owner', { action: 'join', type: 'washer', requestId });
      assert.equal(joined.status, 200);
      const repeated = await command('e2e-owner', { action: 'join', type: 'washer', requestId });
      assert.equal(repeated.status, 200);
      assert.equal(activeTickets(repeated.body, 'washer').length, 1);
      assert.equal((await command('e2e-owner', { action: 'join', type: 'dryer', requestId })).status, 409);
      const machine = repeated.body.machines.find((value) => value.id === MACHINE);
      const checked = await command('e2e-owner', { action: 'confirm_empty', machineId: MACHINE, expectedVersion: machine.version });
      assert.equal(checked.status, 200);
      const ticket = activeTickets(checked.body, 'washer')[0];
      assert.equal(ticket.state, 'called');
      assert.equal(ticket.machineId, MACHINE);
      const start = { action: 'start', machineId: MACHINE, ticketId: ticket.id, callId: ticket.callId };
      assert.equal((await command('e2e-other', start)).status, 403);
      const started = await command('e2e-owner', start);
      assert.equal(started.status, 200);
      runId = started.body.runs.find((run) => run.status === 'running').id;
      const run = ownRun(started.body, runId);
      assert.equal(run.endsAt - run.startedAt, 36 * 60000);
      assert.equal((await command('e2e-owner', start)).status, 409);
    });

    await t.test('사용 중인 대수도 한도에 포함하고 본인만 최신 버전의 시간을 변경', async () => {
      let run = ownRun(await snapshot('e2e-owner'), runId);
      assert.equal((await command('e2e-other', { action: 'adjust', runId, expectedVersion: run.version, minutes: 10 })).status, 403);
      const adjusted = await command('e2e-owner', { action: 'adjust', runId, expectedVersion: run.version, minutes: 10 });
      assert.equal(adjusted.status, 200);
      assert.equal(ownRun(adjusted.body, runId).endsAt - adjusted.body.serverTime, 10 * 60000);
      assert.equal((await command('e2e-owner', { action: 'adjust', runId, expectedVersion: run.version, minutes: 10 })).status, 409);
      assert.equal((await command('e2e-owner', { action: 'join', type: 'washer' })).status, 200);
      assert.equal((await command('e2e-owner', { action: 'join', type: 'washer' })).status, 409);
      const spare = activeTickets(await snapshot('e2e-owner'), 'washer').find((ticket) => ticket.runId !== runId);
      assert.equal((await command('e2e-owner', { action: 'cancel', ticketId: spare.id })).status, 200);
    });

    await t.test('예상 종료 처리에서 양쪽 대상의 알림 기록과 다음 호출 생성', async () => {
      const joined = await command('e2e-next', { action: 'join', type: 'washer' });
      assert.equal(joined.status, 200);
      const waiting = activeTickets(joined.body, 'washer')[0];
      nextTicketId = waiting.id; nextSequence = waiting.sequence;
      assert.equal(waiting.state, 'waiting');
      const past = Date.now() - 60000;
      sql(`UPDATE queue_records SET data=json_set(data,'$.endsAt',${past}) WHERE kind='runs' AND id=${quote(runId)} AND owner_id='e2e-owner';
        UPDATE queue_meta SET revision=revision+1,write_token=${quote(`e2e-clock-${randomUUID()}`)} WHERE id=1;`);
      const current = await snapshot('e2e-owner');
      assert.equal(ownRun(current, runId).status, 'pickup');
      const next = await snapshot('e2e-next');
      const called = next.tickets.find((ticket) => ticket.id === nextTicketId);
      assert.equal(called.state, 'called');
      assert.equal(called.sequence, nextSequence);
      oldCallId = called.callId;
      const jobs = sql(`SELECT json_extract(data,'$.kind') AS kind,owner_id AS userId FROM queue_records
        WHERE kind='jobs' AND (json_extract(data,'$.runId')=${quote(runId)} OR json_extract(data,'$.ticketId')=${quote(nextTicketId)});`);
      assert.ok(jobs.some((job) => job.kind === 'pickup' && job.userId === 'e2e-owner'));
      assert.ok(jobs.some((job) => job.kind === 'call' && job.userId === 'e2e-next'));
    });

    await t.test('미수거 확인은 원래 순번을 유지하고 재호출 및 중복 신고를 차단', async () => {
      const report = { action: 'report', ticketId: nextTicketId, callId: oldCallId, machineId: MACHINE, kind: 'uncollected' };
      const recorded = await command('e2e-next', report);
      assert.equal(recorded.status, 200);
      const ticket = recorded.body.tickets.find((value) => value.id === nextTicketId);
      assert.equal(ticket.state, 'waiting');
      assert.equal(ticket.sequence, nextSequence);
      assert.equal(ticket.callId, null);
      assert.equal(recorded.body.machines.find((machine) => machine.id === MACHINE).status, 'blocked');
      assert.equal(recorded.body.reports.length, 1);
      reportId = recorded.body.reports[0].id;
      assert.equal(recorded.body.reports[0].role, 'reporter');
      assert.equal((await command('e2e-next', report)).status, 409);
      const next = await snapshot('e2e-next');
      assert.equal(next.tickets.find((value) => value.id === nextTicketId).state, 'waiting');
      assert.equal(next.reports.length, 1);
      const owner = await snapshot('e2e-owner');
      assert.equal(owner.reports.find((value) => value.id === reportId).role, 'owner');
      const admin = await request('/api/queue/admin', { user: 'e2e-admin' });
      const detail = admin.body.reports.find((value) => value.id === reportId);
      assert.equal(detail.reporterId, 'e2e-next');
      assert.equal(detail.ownerId, 'e2e-owner');
      assertPrivate(await snapshot());
    });

    await t.test('수거 후 원래 순서로 재배정하고 오래된 신고나 수거는 새 사용을 변경하지 않음', async () => {
      const owner = await snapshot('e2e-owner');
      const oldVersion = ownRun(owner, runId).version;
      const pickup = await command('e2e-owner', { action: 'pickup', runId, expectedVersion: oldVersion });
      assert.equal(pickup.status, 200);
      assert.equal(ownRun(pickup.body, runId).status, 'completed');
      const next = await snapshot('e2e-next');
      const ticket = next.tickets.find((value) => value.id === nextTicketId);
      assert.equal(ticket.state, 'called');
      assert.equal(ticket.sequence, nextSequence);
      assert.notEqual(ticket.callId, oldCallId);
      const started = await command('e2e-next', { action: 'start', ticketId: nextTicketId, callId: ticket.callId, machineId: MACHINE });
      assert.equal(started.status, 200);
      nextRunId = started.body.runs.find((run) => run.status === 'running').id;
      assert.equal((await command('e2e-owner', { action: 'pickup', runId, expectedVersion: oldVersion })).status, 409);
      assert.equal((await command('e2e-next', { action: 'report', ticketId: nextTicketId, callId: oldCallId, machineId: MACHINE, kind: 'uncollected' })).status, 409);
      const unchanged = await snapshot('e2e-next');
      assert.deepEqual(ownRun(unchanged, nextRunId), ownRun(started.body, nextRunId));
      const history = unchanged.reports.find((value) => value.id === reportId);
      assert.ok(history.resolvedAt);
      assert.equal(history.resolution, 'owner_pickup');
      assertPrivate(await snapshot());
    });

    await t.test('최종 수거 후에도 익명 기기 기록은 보존', async () => {
      const run = ownRun(await snapshot('e2e-next'), nextRunId);
      assert.equal((await command('e2e-next', { action: 'pickup', runId: nextRunId, expectedVersion: run.version })).status, 200);
      assert.deepEqual(sql('SELECT id, ends_at, updated_at, version FROM machine_state ORDER BY id;'), legacyBefore);
    });
  } finally {
    resetFixture();
    assert.deepEqual(sql('SELECT id, ends_at, updated_at, version FROM machine_state ORDER BY id;'), legacyBefore);
  }
});
