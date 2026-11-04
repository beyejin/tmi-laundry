import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { executeQueueCommand, getQueueSnapshot, claimNotifications, settleNotification, settleNotifications, tickQueues, getAdminQueueSnapshot } from '../lib/queue-store.ts';
import { parseQueueCommand } from '../lib/queue-engine.ts';

const T = 1_800_000_000_000;
const minute = 60_000;
const machineId = 'h3-women-2-washer-1';
const admin = { id: 'admin', isAdmin: true };
const user = (id) => ({ id, isAdmin: false });
let serial = 0;
function database(legacy = []) {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../drizzle/0000_misty_lester.sql', import.meta.url), 'utf8'));
  sql.exec(readFileSync(new URL('../drizzle/0002_queue.sql', import.meta.url), 'utf8'));
  for (const row of legacy) sql.prepare('INSERT INTO machine_state VALUES (?,?,?,?)').run(...row);
  const statement = (query, values = []) => ({
    query, values,
    bind(...args) { return statement(query, args); },
    async first() { await Promise.resolve(); return sql.prepare(query).get(...values) ?? null; },
    async all() { await Promise.resolve(); return { results: sql.prepare(query).all(...values), success: true }; },
  });
  return { sql, prepare: statement, async batch(statements) {
    // Yield before a transaction to force competing callers to read the same revision.
    await Promise.resolve();
    sql.exec('BEGIN');
    try { const result = statements.map(({ query, values }) => ({ results: sql.prepare(query).all(...values), success: true })); sql.exec('COMMIT'); return result; }
    catch (error) { sql.exec('ROLLBACK'); throw error; }
  } };
}
const command = (db, actor, payload, now = T) => executeQueueCommand(db, actor, { requestId: `req-${++serial}`, ...payload }, now);
const join = (db, actor, type = 'washer', now = T) => command(db, actor, { action: 'join', type }, now);
async function empty(db, target = machineId, now = T, actor = admin) {
  const snapshot = await getQueueSnapshot(db, actor, now);
  return command(db, actor, { action: 'confirm_empty', machineId: target, expectedVersion: snapshot.machines.find((m) => m.id === target).version }, now);
}
async function start(db, actor, ticket, now = T) {
  return command(db, actor, { action: 'start', ticketId: ticket.id, callId: ticket.callId, machineId: ticket.machineId }, now);
}
async function ownerRunning(db, actor = user('owner'), now = T) {
  await empty(db, machineId, now);
  const joined = await join(db, actor, 'washer', now);
  return start(db, actor, joined.tickets[0], now);
}
const raw = (db, kind) => db.sql.prepare('SELECT data FROM queue_records WHERE kind=?').all(kind).map((row) => JSON.parse(row.data));

 test('initial import preserves anonymous records and never assumes untouched machines are empty', async () => {
  const db = database([[machineId, T - minute, T - 37 * minute, 9]]);
  const snapshot = await getQueueSnapshot(db, null, T);
  assert.equal(snapshot.machines.length, 12);
  assert.equal(snapshot.machines.find((m) => m.id === machineId).status, 'check');
  assert.equal(snapshot.machines.filter((m) => m.status === 'unknown').length, 11);
  assert.deepEqual(snapshot.runs, []);
  assert.deepEqual(await claimNotifications(db, T), []);
  assert.equal(db.sql.prepare('SELECT version FROM machine_state WHERE id=?').get(machineId).version, 9);
  await tickQueues(db, T + minute);
  assert.equal(raw(db, 'runs').length, 1);
});

test('end time durably schedules separate owner and next-user notifications', async () => {
  const db = database();
  const running = await ownerRunning(db);
  await join(db, user('next'));
  const snapshot = await getQueueSnapshot(db, user('next'), T + 36 * minute);
  assert.equal(snapshot.tickets[0].state, 'called');
  const jobs = await claimNotifications(db, T + 36 * minute);
  assert.deepEqual(jobs.map((j) => [j.kind, j.userId]).sort(), [['call', 'next'], ['pickup', 'owner']]);
  await settleNotification(db, jobs.find((j) => j.kind === 'pickup'), true, T + 36 * minute);
  await settleNotification(db, jobs.find((j) => j.kind === 'call'), false, T + 36 * minute);
  assert.equal(raw(db, 'jobs').find((j) => j.kind === 'pickup').status, 'sent');
  assert.equal(raw(db, 'jobs').find((j) => j.kind === 'call' && j.userId === 'next').status, 'queued');
  assert.equal(running.runs[0].status, 'running');
});

test('owner pickup notification is scheduled without any queue', async () => {
  const db = database(); await ownerRunning(db);
  const jobs = await claimNotifications(db, T + 36 * minute);
  assert.deepEqual(jobs.map((j) => j.kind), ['pickup']);
  await settleNotification(db, jobs[0], true, T + 36 * minute);
  await tickQueues(db, T + 38 * minute);
  assert.equal(raw(db, 'jobs').filter((j) => j.kind === 'pickup').length, 1);
});

test('uncollected report preserves sequence, blocks repeated calls, and retains resolved history', async () => {
  const db = database(); await ownerRunning(db); await join(db, user('next')); await join(db, user('later'));
  const now = T + 36 * minute;
  const before = await getQueueSnapshot(db, user('next'), now);
  const ticket = before.tickets[0];
  const report = { action: 'report', ticketId: ticket.id, callId: ticket.callId, machineId, kind: 'uncollected', requestId: 'report-unique' };
  const after = await command(db, user('next'), report, now);
  assert.equal(after.tickets[0].sequence, ticket.sequence);
  assert.equal(after.tickets[0].state, 'waiting');
  assert.equal(after.machines.find((m) => m.id === machineId).status, 'blocked');
  await command(db, user('next'), report, now);
  await assert.rejects(command(db, user('next'), { ...report, requestId: 'report-new' }, now), /유효한 호출/);
  assert.equal(raw(db, 'reports').length, 1);
  assert.equal(raw(db, 'jobs').filter((j) => j.kind === 'uncollected').length, 1);
  await tickQueues(db, now + minute);
  assert.equal((await getQueueSnapshot(db, user('next'), now + minute)).tickets[0].state, 'waiting');
  const confirmed = await empty(db, machineId, now + minute, user('later'));
  assert.equal(confirmed.tickets[0].state, 'waiting');
  const first = await getQueueSnapshot(db, user('next'), now + minute);
  assert.equal(first.tickets[0].state, 'called');
  assert.equal(first.reports[0].resolution, 'confirm_empty');
  assert.equal(first.reports[0].resolvedAt, now + minute);
  assert.equal((await getQueueSnapshot(db, user('owner'), now + minute)).runs[0].status, 'completed');
});

test('still-running and fault reports are distinct and fault requires operator recovery', async () => {
  for (const kind of ['still_running', 'fault']) {
    const db = database(); await ownerRunning(db); await join(db, user('next'));
    const now = T + 36 * minute;
    const ticket = (await getQueueSnapshot(db, user('next'), now)).tickets[0];
    const after = await command(db, user('next'), { action: 'report', ticketId: ticket.id, callId: ticket.callId, machineId, kind }, now);
    assert.equal(after.reports[0].kind, kind);
    if (kind === 'fault') {
      await assert.rejects(empty(db, machineId, now, user('next')), /고장/);
      await assert.rejects(command(db, user('next'), { action: 'recover', machineId, expectedVersion: after.machines.find((m) => m.id === machineId).version }, now), /운영자/);
      const restored = await command(db, admin, { action: 'recover', machineId, expectedVersion: after.machines.find((m) => m.id === machineId).version }, now);
      assert.equal(restored.machines.find((m) => m.id === machineId).status, 'available');
    }
  }
});

test('simultaneous pickup and report preserve current state and never affect a later run', async () => {
  const db = database(); await ownerRunning(db); await join(db, user('next'));
  const now = T + 36 * minute;
  const owner = await getQueueSnapshot(db, user('owner'), now);
  const next = await getQueueSnapshot(db, user('next'), now);
  const run = owner.runs[0]; const ticket = next.tickets[0];
  const results = await Promise.allSettled([
    command(db, user('owner'), { action: 'pickup', runId: run.id, expectedVersion: run.version }, now),
    command(db, user('next'), { action: 'report', ticketId: ticket.id, callId: ticket.callId, machineId, kind: 'uncollected' }, now),
  ]);
  assert.equal(results.some((r) => r.status === 'fulfilled'), true);
  let current = await getQueueSnapshot(db, user('next'), now);
  if (current.machines.find((m) => m.id === machineId).status === 'blocked') await empty(db, machineId, now, user('next'));
  current = await getQueueSnapshot(db, user('next'), now);
  const started = await start(db, user('next'), current.tickets[0], now);
  const currentRunId = started.runs[0].id;
  await assert.rejects(command(db, user('owner'), { action: 'pickup', runId: run.id, expectedVersion: run.version }, now), /대상|사용 기록/);
  await assert.rejects(command(db, user('next'), { action: 'report', ticketId: ticket.id, callId: ticket.callId, machineId, kind: 'uncollected' }, now), /유효한 호출/);
  assert.equal((await getQueueSnapshot(db, user('next'), now)).runs.find((r) => r.id === currentRunId).status, 'running');
});

test('concurrent joins enforce account cap and concurrent idempotent requests do not duplicate tickets', async () => {
  const db = database();
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => join(db, user('same'))));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2);
  assert.equal((await getQueueSnapshot(db, user('same'), T)).tickets.length, 2);
  const requests = Array.from({ length: 6 }, () => command(db, user('other'), { action: 'join', type: 'dryer', requestId: 'same-request' }));
  await Promise.all(requests);
  assert.equal((await getQueueSnapshot(db, user('other'), T)).tickets.length, 1);
  await assert.rejects(command(db, user('other'), { action: 'join', type: 'washer', requestId: 'same-request' }), /다른 요청/);
  assert.equal(raw(db, 'tickets').length, 3);
});

test('unready dryer keeps server sequence without stealing an existing assignment', async () => {
  const db = database(); const dryer = 'h3-women-2-dryer-1'; await empty(db, dryer);
  const a = (await join(db, user('a'), 'dryer')).tickets[0];
  const b = (await join(db, user('b'), 'dryer')).tickets[0];
  await command(db, user('b'), { action: 'ready', ticketId: b.id });
  await command(db, user('a'), { action: 'ready', ticketId: a.id });
  assert.equal((await getQueueSnapshot(db, user('b'), T)).tickets[0].state, 'called');
  const waiting = (await getQueueSnapshot(db, user('a'), T)).tickets[0];
  assert.equal(waiting.state, 'waiting'); assert.equal(waiting.sequence, a.sequence);
  await command(db, user('b'), { action: 'cancel', ticketId: b.id });
  assert.equal((await getQueueSnapshot(db, user('a'), T)).tickets[0].state, 'called');
});

test('three failed push attempts pause only next-user ticket, keep original sequence, and reject stale lease settlements', async () => {
  const db = database(); await empty(db);
  const original = (await join(db, user('next'))).tickets[0];
  let now = T;
  let previous;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const job = (await claimNotifications(db, now)).find((j) => j.kind === 'call');
    assert.equal(job.attempts, attempt);
    if (previous) {
      await settleNotification(db, previous, true, now);
      assert.equal(raw(db, 'jobs').find((j) => j.id === job.id).status, 'leased');
    }
    await settleNotification(db, job, false, now);
    previous = job; now += attempt * 15_000;
  }
  const snapshot = await getQueueSnapshot(db, user('next'), now);
  assert.equal(snapshot.tickets[0].state, 'paused'); assert.equal(snapshot.tickets[0].sequence, original.sequence);
  assert.equal(snapshot.machines.find((m) => m.id === machineId).called, false);
  assert.equal(snapshot.reports.length, 0);
  assert.equal(raw(db, 'jobs')[0].status, 'failed');
});

test('missed call expires without a report and rejoining moves to back', async () => {
  const db = database(); await empty(db);
  const first = (await join(db, user('first'))).tickets[0]; await join(db, user('second'));
  const notice = (await claimNotifications(db, T))[0];
  await settleNotification(db, notice, true, T);
  await tickQueues(db, T + 5 * minute);
  const expired = (await getQueueSnapshot(db, user('first'), T + 5 * minute)).tickets[0];
  assert.equal(expired.state, 'expired'); assert.equal(raw(db, 'reports').length, 0);
  const rejoined = (await join(db, user('first'), 'washer', T + 5 * minute)).tickets[0];
  assert.ok(rejoined.sequence > first.sequence); assert.equal(rejoined.state, 'waiting');
});

test('only owner can adjust, extension releases call in original order, old QR calls are rejected', async () => {
  const db = database(); await ownerRunning(db); await join(db, user('next'));
  const now = T + 36 * minute;
  const run = (await getQueueSnapshot(db, user('owner'), now)).runs[0];
  const oldCall = (await getQueueSnapshot(db, user('next'), now)).tickets[0];
  await assert.rejects(command(db, user('next'), { action: 'adjust', runId: run.id, expectedVersion: run.version, minutes: 5 }, now), /본인/);
  await command(db, user('owner'), { action: 'adjust', runId: run.id, expectedVersion: run.version, minutes: 5 }, now);
  const next = (await getQueueSnapshot(db, user('next'), now)).tickets[0];
  assert.equal(next.state, 'waiting'); assert.equal(next.sequence, oldCall.sequence);
  await assert.rejects(start(db, user('next'), oldCall, now), /유효한 호출/);
  assert.equal((await claimNotifications(db, now)).some((j) => j.callId === oldCall.callId), false);
  const future = await claimNotifications(db, now + 5 * minute);
  assert.equal(future.some((j) => j.kind === 'pickup'), true);
});

test('public and unrelated account snapshots omit identities; admin history is authorized', async () => {
  const db = database(); await ownerRunning(db); await join(db, user('next')); const now = T + 36 * minute;
  const ticket = (await getQueueSnapshot(db, user('next'), now)).tickets[0];
  await command(db, user('next'), { action: 'report', ticketId: ticket.id, callId: ticket.callId, machineId, kind: 'uncollected' }, now);
  const publicView = await getQueueSnapshot(db, null, now);
  assert.equal(JSON.stringify(publicView).includes('userId'), false); assert.deepEqual(publicView.reports, []);
  assert.deepEqual((await getQueueSnapshot(db, user('stranger'), now)).reports, []);
  await assert.rejects(getAdminQueueSnapshot(db, user('stranger'), now), /운영자/);
  assert.equal((await getAdminQueueSnapshot(db, admin, now)).reports[0].reporterId, 'next');
});

test('pause prevents new entries and assignments but allows pickup and cancellation', async () => {
  const db = database(); await ownerRunning(db); await join(db, user('next'));
  await command(db, admin, { action: 'pause' });
  await assert.rejects(join(db, user('new')), /중단/);
  const now = T + 36 * minute;
  const owner = await getQueueSnapshot(db, user('owner'), now);
  assert.equal((await getQueueSnapshot(db, user('next'), now)).tickets[0].state, 'waiting');
  await command(db, user('owner'), { action: 'pickup', runId: owner.runs[0].id, expectedVersion: owner.runs[0].version }, now);
  await command(db, admin, { action: 'resume' }, now);
  assert.equal((await getQueueSnapshot(db, user('next'), now)).tickets[0].state, 'called');
});

test('invalid command input is rejected before state mutation', () => {
  assert.equal(parseQueueCommand({ action: 'join', type: 'invalid', requestId: 'x' }), null);
  assert.equal(parseQueueCommand({ action: 'adjust', runId: 'x', expectedVersion: 0, minutes: -1, requestId: 'x' }), null);
  assert.equal(parseQueueCommand({ action: 'pickup', runId: 'x', expectedVersion: NaN, requestId: 'x' }), null);
});

test('extended run creates a new owner notification and preserves previous delivery audit', async () => {
  const db = database(); await ownerRunning(db);
  const now = T + 36 * minute;
  const first = (await claimNotifications(db, now))[0];
  await settleNotification(db, first, true, now);
  const run = (await getQueueSnapshot(db, user('owner'), now)).runs[0];
  await command(db, user('owner'), { action: 'adjust', runId: run.id, expectedVersion: run.version, minutes: 5 }, now);
  const second = (await claimNotifications(db, now + 5 * minute))[0];
  assert.equal(second.kind, 'pickup'); assert.notEqual(second.id, first.id);
  assert.equal(raw(db, 'jobs').find((j) => j.id === first.id).status, 'sent');
  assert.equal(second.url, `/?queue=1&calledMachine=${machineId}`);
});

test('pause at expected end never creates a call just before pausing', async () => {
  const db = database(); await ownerRunning(db); await join(db, user('next'));
  const now = T + 36 * minute;
  await command(db, admin, { action: 'pause' }, now);
  const next = await getQueueSnapshot(db, user('next'), now);
  assert.equal(next.tickets[0].state, 'waiting');
  assert.equal(raw(db, 'jobs').some((j) => j.kind === 'call' && j.userId === 'next'), false);
  assert.equal((await claimNotifications(db, now))[0].kind, 'pickup');
});

test('concurrent dispatch gives each machine one ticket and each ticket one machine', async () => {
  const db = database();
  await empty(db); await empty(db, 'h3-women-2-washer-2');
  await Promise.all(Array.from({ length: 8 }, (_, i) => join(db, user(`concurrent-${i}`))));
  const called = raw(db, 'tickets').filter((t) => t.state === 'called');
  assert.equal(called.length, 2);
  assert.equal(new Set(called.map((t) => t.machineId)).size, 2);
  assert.equal(new Set(called.map((t) => t.callId)).size, 2);
  for (const machine of raw(db, 'machines')) if (machine.ticketId) assert.equal(called.find((t) => t.id === machine.ticketId).machineId, machine.id);
});

test('expired notification lease can be reclaimed once and old sender cannot settle it', async () => {
  const db = database(); await empty(db); await join(db, user('next'));
  const first = (await claimNotifications(db, T))[0];
  const second = (await claimNotifications(db, T + minute))[0];
  assert.equal(second.id, first.id); assert.notEqual(second.leaseToken, first.leaseToken); assert.equal(second.attempts, 2);
  await settleNotification(db, first, true, T + minute);
  assert.equal(raw(db, 'jobs')[0].status, 'leased');
  await settleNotification(db, second, true, T + minute);
  assert.equal(raw(db, 'jobs')[0].status, 'sent');
});

test('picked-up or started runs cancel pending owner notifications', async () => {
  const db = database(); await ownerRunning(db); await join(db, user('next'));
  const now = T + 36 * minute;
  const next = await getQueueSnapshot(db, user('next'), now);
  await start(db, user('next'), next.tickets[0], now);
  const jobs = await claimNotifications(db, now);
  assert.equal(jobs.some((j) => j.kind === 'pickup' && j.userId === 'owner'), false);
  assert.equal(jobs.some((j) => j.kind === 'call' && j.userId === 'next'), false);
});

test('report received after owner pickup cannot fabricate a new uncollected use', async () => {
  const db = database(); await ownerRunning(db); await join(db, user('next'));
  const now = T + 36 * minute;
  const owner = await getQueueSnapshot(db, user('owner'), now);
  const ticket = (await getQueueSnapshot(db, user('next'), now)).tickets[0];
  await command(db, user('owner'), { action: 'pickup', runId: owner.runs[0].id, expectedVersion: owner.runs[0].version }, now);
  await assert.rejects(command(db, user('next'), { action: 'report', ticketId: ticket.id, callId: ticket.callId, machineId, kind: 'uncollected' }, now), /수거 상태가 변경/);
  assert.equal(raw(db, 'reports').length, 0);
  assert.equal(raw(db, 'runs').length, 1);
  const started = await start(db, user('next'), ticket, now);
  assert.equal(started.runs[0].status, 'running');
});

test('paused cleanup keeps current call usable and retains collecting run in account cap', async () => {
  const db = database(); await ownerRunning(db); await join(db, user('owner'));
  await command(db, admin, { action: 'pause' });
  const now = T + 36 * minute;
  await command(db, admin, { action: 'resume' }, now);
  await assert.rejects(join(db, user('owner'), 'washer', now), /2대까지/);
  const owner = await getQueueSnapshot(db, user('owner'), now);
  const called = owner.tickets.find((t) => t.state === 'called');
  assert.ok(called);
  await command(db, admin, { action: 'pause' }, now);
  const started = await start(db, user('owner'), called, now);
  assert.equal(started.runs.filter((r) => r.status !== 'completed').length, 1);
  const cancelled = started.tickets.find((t) => t.state === 'completed');
  assert.ok(cancelled);
});


test('batch settlements share one commit and claiming respects caller batch limit', async () => {
  const db = database(); await empty(db); await empty(db, 'h3-women-2-washer-2');
  await join(db, user('a')); await join(db, user('b'));
  const first = await claimNotifications(db, T, 1);
  assert.equal(first.length, 1);
  const second = await claimNotifications(db, T, 1);
  assert.equal(second.length, 1); assert.notEqual(first[0].id, second[0].id);
  const revision = db.sql.prepare('SELECT revision FROM queue_meta').get().revision;
  await settleNotifications(db, [...first, ...second].map((j) => ({ id: j.id, leaseToken: j.leaseToken, success: true })), T);
  assert.equal(db.sql.prepare('SELECT revision FROM queue_meta').get().revision, revision + 1);
  assert.equal(raw(db, 'jobs').filter((j) => j.status === 'sent').length, 2);
});


test('call deadline preserves the original sequence without accepted delivery after zero, one or two attempts', async () => {
  for (const failures of [0, 1, 2]) {
    const db = database(); await empty(db);
    const initial = (await join(db, user('next'))).tickets[0];
    await join(db, user('later'));
    for (let i = 0; i < failures; i++) {
      const now = T + i * minute;
      const job = (await claimNotifications(db, now))[0];
      await settleNotification(db, job, false, now);
    }
    const queued = raw(db, 'jobs').find((j) => j.callId === initial.callId);
    assert.equal(queued.status, 'queued'); assert.equal(queued.attempts, failures);
    const snapshot = await getQueueSnapshot(db, user('next'), T + 5 * minute);
    assert.equal(snapshot.tickets[0].state, 'paused');
    assert.equal(snapshot.tickets[0].sequence, initial.sequence);
    assert.match(snapshot.tickets[0].pauseReason, /전송을 확인하지 못/);
    assert.equal(snapshot.reports.length, 0);
    assert.equal((await getQueueSnapshot(db, user('later'), T + 5 * minute)).tickets[0].state, 'called');
    const retry = await command(db, user('next'), { action: 'ready', ticketId: initial.id }, T + 5 * minute);
    assert.equal(retry.tickets[0].state, 'waiting');
    assert.equal(retry.tickets[0].sequence, initial.sequence);
  }
});

test('unsettled notification lease at call deadline preserves sequence and ignores the late receipt', async () => {
  const db = database(); await empty(db);
  const initial = (await join(db, user('next'))).tickets[0];
  const leased = (await claimNotifications(db, T + 4 * minute + 50_000))[0];
  const deadline = T + 5 * minute;
  const snapshot = await getQueueSnapshot(db, user('next'), deadline);
  assert.equal(snapshot.tickets[0].state, 'paused');
  await settleNotification(db, leased, true, deadline + 1);
  assert.equal((await getQueueSnapshot(db, user('next'), deadline + 1)).tickets[0].state, 'paused');
  assert.equal(raw(db, 'jobs').find((j) => j.id === leased.id).status, 'cancelled');
});


test('acceptance recorded after the call deadline does not become a no-show', async () => {
  const db = database(); await empty(db);
  const initial = (await join(db, user('next'))).tickets[0];
  const leased = (await claimNotifications(db, T + 4 * minute + 59_000))[0];
  await settleNotification(db, leased, true, T + 5 * minute + 1);
  const snapshot = await getQueueSnapshot(db, user('next'), T + 5 * minute + 1);
  assert.equal(snapshot.tickets[0].state, 'paused');
  assert.equal(snapshot.tickets[0].sequence, initial.sequence);
  assert.equal(raw(db, 'jobs').find((j) => j.id === leased.id).status, 'sent');
});
