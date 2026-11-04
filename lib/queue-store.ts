import type { StateRow } from "./laundry.ts";
import type { QueueActor, QueueCommand, QueueNotificationJob } from "./queue-contract.ts";
import { QueueError, activeTicket, applyQueueCommand, claimQueueNotifications, initialQueueState, parseQueueCommand, publicQueueMachines, queueSnapshot, settleQueueNotification, tickQueueState, type QueueState } from "./queue-engine.ts";

type RecordRow = { kind: string; id: string; data: string };
type MetaRow = { revision: number; sequence: number; paused: number };
type RequestKey = { userId: string; requestId: string; command: string };
const collections = ["machines", "tickets", "runs", "reports", "jobs"] as const;
function rows(state: QueueState) {
  return collections.flatMap((kind) => state[kind].map((entity) => {
    let owner: string | null = null; let participant: string | null = null; let status = "active"; let active = true; let pool: string | null = null; let createdAt = 0;
    if ("type" in entity) pool = entity.type;
    if ("userId" in entity) owner = entity.userId;
    if ("createdAt" in entity) createdAt = entity.createdAt;
    else if ("reportedAt" in entity) createdAt = entity.reportedAt;
    else if ("startedAt" in entity) createdAt = entity.startedAt;
    else if ("updatedAt" in entity) createdAt = entity.updatedAt;
    if (kind === "tickets") { const ticket = entity as QueueState["tickets"][number]; status = ticket.state; active = activeTicket(ticket); }
    if (kind === "runs") { const run = entity as QueueState["runs"][number]; status = run.status; active = run.status !== "completed"; }
    if (kind === "reports") { const report = entity as QueueState["reports"][number]; status = report.resolvedAt === null ? "open" : "resolved"; active = report.resolvedAt === null; owner = report.ownerId; participant = report.userId; }
    if (kind === "jobs") { const job = entity as QueueNotificationJob; status = job.status; active = job.status === "queued" || job.status === "leased"; }
    return { kind, id: entity.id, pool, owner, participant, status, active: active ? 1 : 0, createdAt, data: JSON.stringify(entity) };
  }));
}
function writeRows(db: D1Database, state: QueueState, token: string, previous = new Map<string, string>()) {
  return rows(state).filter((row) => previous.get(`${row.kind}:${row.id}`) !== row.data).map((row) => db.prepare(`INSERT INTO queue_records (kind,id,pool,owner_id,participant_id,status,active,created_at,data)
    SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9 WHERE EXISTS (SELECT 1 FROM queue_meta WHERE id=1 AND write_token=?10)
    ON CONFLICT(kind,id) DO UPDATE SET pool=excluded.pool,owner_id=excluded.owner_id,participant_id=excluded.participant_id,status=excluded.status,active=excluded.active,created_at=excluded.created_at,data=excluded.data`)
    .bind(row.kind, row.id, row.pool, row.owner, row.participant, row.status, row.active, row.createdAt, row.data, token));
}
async function ensureInitialized(db: D1Database, now: number) {
  if (await db.prepare("SELECT id FROM queue_meta WHERE id=1").first()) return;
  const legacy = await db.prepare("SELECT id, ends_at, updated_at, version FROM machine_state WHERE id LIKE 'h3-women-%'").all<StateRow>();
  const state = initialQueueState(legacy.results, now);
  const token = crypto.randomUUID();
  await db.batch([
    db.prepare("INSERT INTO queue_meta (id,revision,sequence,paused,write_token) VALUES (1,0,0,0,?) ON CONFLICT(id) DO NOTHING").bind(token),
    ...writeRows(db, state, token),
  ]);
}
async function readState(db: D1Database, actor?: QueueActor | null, request?: RequestKey) {
  const statements = [db.prepare("SELECT revision,sequence,paused FROM queue_meta WHERE id=1"), db.prepare("SELECT kind,id,data FROM queue_records WHERE active=1")];
  if (actor) statements.push(db.prepare(`SELECT kind,id,data FROM queue_records WHERE active=0 AND kind IN ('tickets','runs','reports') AND (owner_id=?1 OR participant_id=?1 OR (?2=1 AND kind='reports')) ORDER BY created_at DESC LIMIT 200`).bind(actor.id, actor.isAdmin ? 1 : 0));
  if (request) statements.push(db.prepare("SELECT command FROM queue_requests WHERE user_id=? AND request_id=?").bind(request.userId, request.requestId));
  const result = await db.batch(statements);
  const meta = result[0].results[0] as MetaRow;
  const state: QueueState = { revision: meta.revision, sequence: meta.sequence, paused: !!meta.paused, machines: [], tickets: [], runs: [], reports: [], jobs: [] };
  const records = [...result[1].results, ...(actor ? result[2].results : [])] as RecordRow[];
  for (const row of records) {
    if (collections.includes(row.kind as typeof collections[number])) (state[row.kind as typeof collections[number]] as unknown[]).push(JSON.parse(row.data));
  }
  const prior = request ? (result[result.length - 1].results[0] as { command: string } | undefined)?.command : undefined;
  return { state, prior };
}
async function mutate<T>(db: D1Database, now: number, update: (state: QueueState) => T, request?: RequestKey): Promise<T | undefined> {
  await ensureInitialized(db, now);
  for (let attempt = 0; attempt < 12; attempt++) {
    const { state, prior } = await readState(db, undefined, request);
    if (prior !== undefined) {
      if (prior !== request?.command) throw new QueueError(409, "이미 다른 요청에 사용된 요청 번호예요.");
      return undefined;
    }
    const before = new Map(rows(state).map((row) => [`${row.kind}:${row.id}`, row.data]));
    const metaBefore = JSON.stringify([state.sequence, state.paused]);
    const value = update(state);
    const token = crypto.randomUUID();
    const writes = writeRows(db, state, token, before);
    if (!request && writes.length === 0 && metaBefore === JSON.stringify([state.sequence, state.paused])) return value;
    const check = request ? " AND NOT EXISTS (SELECT 1 FROM queue_requests WHERE user_id=?5 AND request_id=?6)" : "";
    const args = [state.sequence, state.paused ? 1 : 0, token, state.revision, ...(request ? [request.userId, request.requestId] : [])];
    const statements = [db.prepare(`UPDATE queue_meta SET revision=revision+1,sequence=?1,paused=?2,write_token=?3 WHERE id=1 AND revision=?4${check} RETURNING revision`).bind(...args), ...writes];
    if (request) statements.push(db.prepare("INSERT INTO queue_requests (user_id,request_id,command,created_at) SELECT ?1,?2,?3,?4 WHERE EXISTS (SELECT 1 FROM queue_meta WHERE id=1 AND write_token=?5)").bind(request.userId, request.requestId, request.command, now, token));
    const committed = await db.batch(statements);
    if (committed[0].results.length > 0) return value;
  }
  throw new QueueError(409, "요청이 몰리고 있어요. 잠시 후 다시 시도해 주세요.");
}

export async function tickQueues(db: D1Database, now = Date.now()) {
  await mutate(db, now, (state) => tickQueueState(state, now));
}
export async function getQueueSnapshot(db: D1Database, actor: QueueActor | null, now = Date.now()) {
  await tickQueues(db, now);
  const { state } = await readState(db, actor);
  return queueSnapshot(state, actor, now);
}
export async function getPublicQueueMachines(db: D1Database, now = Date.now()) {
  await tickQueues(db, now);
  return publicQueueMachines((await readState(db)).state);
}
export async function executeQueueCommand(db: D1Database, actor: QueueActor, value: QueueCommand, now = Date.now()) {
  const command = parseQueueCommand(value);
  if (!command) throw new QueueError(400, "요청 내용을 확인해 주세요.");
  if (!actor.id) throw new QueueError(401, "학교 계정 로그인이 필요해요.");
  await mutate(db, now, (state) => applyQueueCommand(state, actor, command, now), { userId: actor.id, requestId: command.requestId, command: JSON.stringify(command) });
  return getQueueSnapshot(db, actor, now);
}
export async function claimNotifications(db: D1Database, now = Date.now(), limit = 12) {
  return (await mutate(db, now, (state) => claimQueueNotifications(state, now, limit))) ?? [];
}
export async function settleNotification(db: D1Database, job: { id: string; leaseToken: string | null }, success: boolean, now = Date.now()) {
  await mutate(db, now, (state) => settleQueueNotification(state, job, success, now));
}

export async function getAdminQueueSnapshot(db: D1Database, actor: QueueActor, now = Date.now()) {
  if (!actor.isAdmin) throw new QueueError(403, "운영자만 이력을 볼 수 있어요.");
  return getQueueSnapshot(db, actor, now);
}

export async function settleNotifications(db: D1Database, results: { id: string; leaseToken: string | null; success: boolean }[], now = Date.now()) {
  await mutate(db, now, (state) => {
    for (const result of results) settleQueueNotification(state, result, result.success, now, false);
    tickQueueState(state, now);
  });
}
