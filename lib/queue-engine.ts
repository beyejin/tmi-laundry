import { MACHINES, type StateRow } from "./laundry.ts";
import { QUEUE_CALL_MS, isPilotMachine, type QueueActor, type QueueCommand, type QueueType, type QueueSnapshot, type QueueNotificationJob, type QueueMachineView, type QueueTicketView, type QueueRunView, type QueueReportView, type TicketState, type ReportKind } from "./queue-contract.ts";

export class QueueError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export type QueueMachine = { id: string; type: QueueType; knownEmpty: boolean; runId: string | null; ticketId: string | null; blocked: ReportKind | null; version: number; updatedAt: number };
export type QueueTicket = Omit<QueueTicketView, "ahead"> & { userId: string; callRunId: string | null; callAcceptedAt: number | null };
export type QueueRun = QueueRunView & { userId: string | null; ticketId: string | null; pickupNoticeCreated: boolean; pickupGeneration: number };
export type QueueReport = Omit<QueueReportView, "role"> & { userId: string; ownerId: string | null; callId: string };
export type QueueState = { revision: number; sequence: number; paused: boolean; machines: QueueMachine[]; tickets: QueueTicket[]; runs: QueueRun[]; reports: QueueReport[]; jobs: QueueNotificationJob[] };
export const activeTicket = (ticket: QueueTicket) => !["completed", "cancelled", "expired"].includes(ticket.state);
const id = () => crypto.randomUUID();
const required = <T>(value: T | undefined, message = "대상이 변경됐어요. 새로고침해 주세요."): T => { if (!value) throw new QueueError(409, message); return value; };
const owned = <T extends { userId: string | null }>(value: T, actor: QueueActor) => { if (value.userId !== actor.id) throw new QueueError(403, "본인의 이용 기록만 변경할 수 있어요."); return value; };
const terminalJob = (job: QueueNotificationJob) => ["sent", "failed", "cancelled"].includes(job.status);

export function parseQueueCommand(value: unknown): QueueCommand | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const str = (key: string) => typeof v[key] === "string" && /^[A-Za-z0-9_:-]{1,160}$/.test(v[key] as string);
  if (!str("requestId")) return null;
  const requestId = v.requestId as string;
  const action = v.action;
  if (action === "join" && (v.type === "washer" || v.type === "dryer")) return { action, type: v.type, requestId };
  if ((action === "ready" || action === "cancel") && str("ticketId")) return { action, ticketId: v.ticketId as string, requestId };
  if ((action === "start" || action === "report") && ["ticketId", "callId", "machineId"].every(str)) {
    const common = { ticketId: v.ticketId as string, callId: v.callId as string, machineId: v.machineId as string, requestId };
    if (action === "start") return { action, ...common };
    if (["uncollected", "still_running", "fault"].includes(String(v.kind))) return { action, kind: v.kind as ReportKind, ...common };
  }
  const version = Number.isSafeInteger(v.expectedVersion) && Number(v.expectedVersion) >= 0;
  if ((action === "pickup" || action === "adjust") && str("runId") && version) {
    const common = { runId: v.runId as string, expectedVersion: Number(v.expectedVersion), requestId };
    if (action === "pickup") return { action, ...common };
    if (Number.isInteger(v.minutes) && Number(v.minutes) >= 1 && Number(v.minutes) <= 180) return { action, minutes: Number(v.minutes), ...common };
  }
  if ((action === "confirm_empty" || action === "recover") && str("machineId") && version) return { action, machineId: v.machineId as string, expectedVersion: Number(v.expectedVersion), requestId };
  if (action === "pause" || action === "resume") return { action, requestId };
  return null;
}

export function initialQueueState(rows: StateRow[], now: number): QueueState {
  const state: QueueState = { revision: 0, sequence: 0, paused: false, machines: [], tickets: [], runs: [], reports: [], jobs: [] };
  for (const definition of MACHINES.filter((m) => isPilotMachine(m.id))) {
    const old = rows.find((row) => row.id === definition.id);
    const runId = old?.ends_at != null ? `legacy:${definition.id}:${old.version}` : null;
    state.machines.push({ id: definition.id, type: definition.type, knownEmpty: false, runId, ticketId: null, blocked: null, version: old?.version ?? 0, updatedAt: old?.updated_at ?? now });
    if (runId && old?.ends_at != null) state.runs.push({ id: runId, machineId: definition.id, type: definition.type, startedAt: old.updated_at, endsAt: old.ends_at, collectedAt: null, status: old.ends_at > now ? "running" : "pickup", version: 1, userId: null, ticketId: null, pickupNoticeCreated: false, pickupGeneration: 0 });
  }
  return state;
}
function changeMachine(machine: QueueMachine, now: number) { machine.version++; machine.updatedAt = now; }
function addJob(state: QueueState, options: { id: string; userId: string; kind: QueueNotificationJob["kind"]; body: string; machineId: string; ticketId?: string; callId?: string; runId?: string; expiresAt?: number }, now: number) {
  if (state.jobs.some((j) => j.id === options.id)) return;
  state.jobs.push({ id: options.id, userId: options.userId, kind: options.kind, title: "TMI 세탁실", body: options.body, url: `/?queue=1&calledMachine=${options.machineId}`, tag: options.id, ticketId: options.ticketId ?? null, callId: options.callId ?? null, runId: options.runId ?? null, expiresAt: options.expiresAt ?? null, status: "queued", attempts: 0, nextAttemptAt: now, leaseUntil: null, leaseToken: null, createdAt: now });
}
function cancelJobs(state: QueueState, predicate: (job: QueueNotificationJob) => boolean) {
  for (const job of state.jobs) if (!terminalJob(job) && predicate(job)) { job.status = "cancelled"; job.leaseToken = null; job.leaseUntil = null; }
}
function releaseCall(state: QueueState, ticket: QueueTicket, next: TicketState, now: number) {
  const callId = ticket.callId;
  const machine = state.machines.find((m) => m.ticketId === ticket.id);
  if (machine) { machine.ticketId = null; changeMachine(machine, now); }
  cancelJobs(state, (job) => job.callId === callId && job.kind === "call");
  ticket.state = next; ticket.machineId = null; ticket.callId = null; ticket.callRunId = null; ticket.callAcceptedAt = null; ticket.calledAt = null; ticket.expiresAt = null;
}
function closeRun(state: QueueState, machine: QueueMachine, now: number, resolution: string) {
  if (machine.runId) {
    const run = required(state.runs.find((r) => r.id === machine.runId));
    run.status = "completed"; run.collectedAt = now; run.version++;
    const ticket = state.tickets.find((t) => t.id === run.ticketId);
    if (ticket) ticket.state = "completed";
    for (const report of state.reports) if (report.runId === run.id && report.resolvedAt === null) { report.resolvedAt = now; report.resolution = resolution; }
    cancelJobs(state, (job) => job.runId === run.id && job.kind !== "call");
  }
  machine.runId = null; machine.knownEmpty = true;
  if (machine.blocked !== "fault") machine.blocked = null;
  changeMachine(machine, now);
}
function pauseFailedCall(state: QueueState, job: QueueNotificationJob, now: number) {
  const ticket = state.tickets.find((t) => t.id === job.ticketId && t.callId === job.callId && t.state === "called");
  if (job.kind === "call" && ticket) { releaseCall(state, ticket, "paused", now); ticket.pauseReason = "알림 전송에 실패했어요. 알림 설정 후 준비 완료를 눌러 주세요."; }
}

export function tickQueueState(state: QueueState, now: number) {
  for (const run of state.runs) {
    if (run.status === "completed" || run.endsAt > now) continue;
    if (run.status !== "pickup") { run.status = "pickup"; run.version++; const ticket = state.tickets.find((t) => t.id === run.ticketId); if (ticket) ticket.state = "pickup"; }
    if (run.userId && !run.pickupNoticeCreated) {
      addJob(state, { id: `pickup:${run.id}:${run.pickupGeneration}`, userId: run.userId, kind: "pickup", body: "예상 사용 시간이 끝났어요. 빨래를 수거해 주세요.", machineId: run.machineId, runId: run.id }, now);
      run.pickupNoticeCreated = true;
    }
  }
  for (const ticket of state.tickets) {
    if (ticket.state !== "called" || ticket.expiresAt === null || ticket.expiresAt > now) continue;
    // Lack of a delivery receipt is not evidence that a user ignored their call.
    const accepted = ticket.callAcceptedAt != null;
    releaseCall(state, ticket, accepted ? "expired" : "paused", now);
    if (!accepted) ticket.pauseReason = "호출 알림 전송을 확인하지 못했어요. 원래 순번을 유지합니다. 알림 설정 후 준비 완료를 눌러 주세요.";
  }
  for (const job of state.jobs) {
    if (job.status === "leased" && (job.leaseUntil ?? 0) <= now) {
      job.leaseUntil = null; job.leaseToken = null;
      if (job.attempts >= 3) { job.status = "failed"; pauseFailedCall(state, job, now); } else job.status = "queued";
    }
    if (!terminalJob(job) && job.expiresAt !== null && job.expiresAt <= now) { job.status = "cancelled"; job.leaseToken = null; job.leaseUntil = null; }
  }
  if (state.paused) return;
  for (const machine of state.machines) {
    if (machine.ticketId || machine.blocked) continue;
    const run = state.runs.find((r) => r.id === machine.runId);
    if (run ? run.endsAt > now : !machine.knownEmpty) continue;
    const ticket = state.tickets.filter((t) => t.type === machine.type && t.state === "waiting").sort((a, b) => a.sequence - b.sequence)[0];
    if (!ticket) continue;
    ticket.state = "called"; ticket.machineId = machine.id; ticket.callId = id(); ticket.callRunId = machine.runId; ticket.callAcceptedAt = null; ticket.calledAt = now; ticket.expiresAt = now + QUEUE_CALL_MS;
    machine.ticketId = ticket.id; changeMachine(machine, now);
    addJob(state, { id: `call:${ticket.callId}`, userId: ticket.userId, kind: "call", body: "배정된 기기를 확인해 주세요. 5분 안에 QR로 시작해 주세요.", machineId: machine.id, ticketId: ticket.id, callId: ticket.callId, expiresAt: ticket.expiresAt }, now);
  }
}

export function applyQueueCommand(state: QueueState, actor: QueueActor, command: QueueCommand, now: number) {
  if (command.action === "pause" && actor.isAdmin) state.paused = true;
  tickQueueState(state, now);
  const machineFor = (machineId: string) => required(state.machines.find((m) => m.id === machineId), "시험 운영 구역의 기기만 이용할 수 있어요.");
  const ticketFor = (ticketId: string) => owned(required(state.tickets.find((t) => t.id === ticketId)), actor);
  if (command.action === "pause" || command.action === "resume") {
    if (!actor.isAdmin) throw new QueueError(403, "운영자만 변경할 수 있어요.");
    state.paused = command.action === "pause";
  } else if (command.action === "join") {
    if (state.paused) throw new QueueError(409, "현재 새 대기 접수를 중단했어요.");
    if (state.tickets.filter((t) => t.userId === actor.id && t.type === command.type && activeTicket(t)).length >= 2) throw new QueueError(409, "종류별로 대기와 사용, 수거 대기를 합쳐 2대까지 이용할 수 있어요.");
    state.tickets.push({ id: id(), userId: actor.id, type: command.type, sequence: ++state.sequence, state: command.type === "washer" ? "waiting" : "preparing", createdAt: now, machineId: null, callId: null, callRunId: null, callAcceptedAt: null, calledAt: null, expiresAt: null, runId: null, pauseReason: null });
  } else if (command.action === "ready" || command.action === "cancel") {
    const ticket = ticketFor(command.ticketId);
    if (command.action === "ready") {
      if (!["preparing", "paused"].includes(ticket.state)) throw new QueueError(409, "지금 준비 완료로 바꿀 수 없는 대기표예요.");
      ticket.state = "waiting"; ticket.pauseReason = null;
    } else {
      if (!["preparing", "waiting", "called", "paused"].includes(ticket.state)) throw new QueueError(409, "이미 시작했거나 종료된 대기표예요.");
      releaseCall(state, ticket, "cancelled", now);
    }
  } else if (command.action === "start" || command.action === "report") {
    const ticket = ticketFor(command.ticketId);
    const machine = machineFor(command.machineId);
    if (ticket.state !== "called" || ticket.callId !== command.callId || ticket.machineId !== machine.id || machine.ticketId !== ticket.id || (ticket.expiresAt ?? 0) <= now) throw new QueueError(409, "유효한 호출이 아니에요. 내 대기를 다시 확인해 주세요.");
    if (command.action === "start") {
      closeRun(state, machine, now, "next_start");
      const callId = ticket.callId;
      releaseCall(state, ticket, "in_use", now);
      const runId = id();
      const run: QueueRun = { id: runId, machineId: machine.id, type: machine.type, userId: actor.id, ticketId: ticket.id, startedAt: now, endsAt: now + (machine.type === "washer" ? 36 : 45) * 60_000, status: "running", collectedAt: null, version: 1, pickupNoticeCreated: false, pickupGeneration: 0 };
      state.runs.push(run); ticket.runId = runId; ticket.machineId = machine.id; machine.runId = runId; machine.knownEmpty = false; changeMachine(machine, now);
      cancelJobs(state, (job) => job.callId === callId);
    } else {
      if (ticket.callRunId !== machine.runId) throw new QueueError(409, "호출 후 수거 상태가 변경됐어요. 기기를 다시 확인해 주세요.");
      let run = state.runs.find((r) => r.id === machine.runId);
      if (!run) {
        run = { id: id(), machineId: machine.id, type: machine.type, userId: null, ticketId: null, startedAt: now, endsAt: now, status: "pickup", collectedAt: null, version: 1, pickupNoticeCreated: false, pickupGeneration: 0 };
        state.runs.push(run); machine.runId = run.id;
      }
      if (state.reports.some((r) => r.runId === run.id && r.resolvedAt === null)) throw new QueueError(409, "이미 현장 확인이 접수된 사용 기록이에요.");
      const reportId = id();
      state.reports.push({ id: reportId, machineId: machine.id, runId: run.id, kind: command.kind, userId: actor.id, ownerId: run.userId, callId: command.callId, calledAt: ticket.calledAt!, reportedAt: now, expectedEndAt: run.endsAt, resolvedAt: null, resolution: null });
      releaseCall(state, ticket, "waiting", now); machine.blocked = command.kind; machine.knownEmpty = false; changeMachine(machine, now);
      if (run.userId) addJob(state, { id: `report:${reportId}`, userId: run.userId, kind: command.kind === "uncollected" ? "uncollected" : "still_running", body: command.kind === "uncollected" ? "다음 이용자가 빨래가 남아 있다고 확인했어요. 수거 후 완료를 눌러 주세요." : "기기 상태 확인이 접수됐어요. 내 사용 기록을 확인해 주세요.", machineId: machine.id, runId: run.id }, now);
    }
  } else if (command.action === "pickup" || command.action === "adjust") {
    const run = owned(required(state.runs.find((r) => r.id === command.runId)), actor);
    const machine = machineFor(run.machineId);
    if (run.status === "completed" || machine.runId !== run.id || run.version !== command.expectedVersion) throw new QueueError(409, "사용 기록이 변경됐어요. 새로고침해 주세요.");
    if (command.action === "pickup") closeRun(state, machine, now, "owner_pickup");
    else {
      run.endsAt = now + command.minutes * 60_000; run.status = "running"; run.version++;
      const ownTicket = state.tickets.find((t) => t.id === run.ticketId); if (ownTicket) ownTicket.state = "in_use";
      const called = state.tickets.find((t) => t.id === machine.ticketId);
      if (called) {
        const oldCallId = called.callId!;
        releaseCall(state, called, "waiting", now);
        addJob(state, { id: `released:${oldCallId}`, userId: called.userId, kind: "released", body: "기기 사용 시간이 변경됐어요. 원래 순번을 유지하며 다른 기기를 기다립니다.", machineId: machine.id, ticketId: called.id }, now);
      }
      run.pickupNoticeCreated = false; run.pickupGeneration++;
      cancelJobs(state, (job) => job.kind === "pickup" && job.runId === run.id);
      changeMachine(machine, now);
    }
  } else if (command.action === "confirm_empty" || command.action === "recover") {
    const machine = machineFor(command.machineId);
    if (machine.version !== command.expectedVersion) throw new QueueError(409, "기기 상태가 변경됐어요. 다시 확인해 주세요.");
    if (command.action === "recover") {
      if (!actor.isAdmin) throw new QueueError(403, "고장 복구는 운영자만 할 수 있어요.");
      if (machine.blocked !== "fault") throw new QueueError(409, "고장으로 제외된 기기가 아니에요.");
      machine.blocked = null;
    } else {
      if (machine.blocked === "fault") throw new QueueError(409, "고장 기기는 운영자의 복구가 필요해요.");
      const participant = state.tickets.some((t) => t.userId === actor.id && t.type === machine.type && ["preparing", "waiting", "called", "paused"].includes(t.state));
      if (!actor.isAdmin && !participant) throw new QueueError(403, "같은 종류의 대기줄 참여자만 빈 기기를 확인할 수 있어요.");
      const run = state.runs.find((r) => r.id === machine.runId);
      if (run && run.endsAt > now && !machine.blocked) throw new QueueError(409, "아직 예상 사용 시간이 남아 있어요.");
    }
    closeRun(state, machine, now, command.action);
  }
  tickQueueState(state, now);
}

export function claimQueueNotifications(state: QueueState, now: number, limit = 12): QueueNotificationJob[] {
  tickQueueState(state, now);
  const claimed = state.jobs.filter((job) => job.status === "queued" && job.nextAttemptAt <= now).sort((a, b) => a.createdAt - b.createdAt).slice(0, Math.max(1, Math.min(25, Math.trunc(limit) || 12)));
  for (const job of claimed) { job.status = "leased"; job.attempts++; job.leaseToken = id(); job.leaseUntil = now + 60_000; }
  return claimed;
}
export function settleQueueNotification(state: QueueState, target: { id: string; leaseToken: string | null }, success: boolean, now: number, reconcile = true) {
  const job = state.jobs.find((j) => j.id === target.id);
  if (!job || job.status !== "leased" || !target.leaseToken || job.leaseToken !== target.leaseToken) return;
  job.leaseToken = null; job.leaseUntil = null;
  if (success) {
    job.status = "sent";
    if (job.kind === "call") {
      const ticket = state.tickets.find((t) => t.id === job.ticketId && t.callId === job.callId && t.state === "called");
      if (ticket && (ticket.expiresAt ?? 0) > now) ticket.callAcceptedAt = now;
    }
  }
  else if (job.attempts >= 3) { job.status = "failed"; pauseFailedCall(state, job, now); }
  else { job.status = "queued"; job.nextAttemptAt = now + job.attempts * 15_000; }
  if (reconcile) tickQueueState(state, now);
}

export function publicQueueMachines(state: QueueState): QueueMachineView[] {
  return state.machines.map((machine) => {
    const definition = required(MACHINES.find((m) => m.id === machine.id));
    const run = state.runs.find((r) => r.id === machine.runId);
    return { id: machine.id, type: machine.type, name: definition.name, locationId: definition.locationId, status: machine.blocked === "fault" ? "fault" : machine.blocked ? "blocked" : run ? run.status === "running" ? "running" : "check" : machine.knownEmpty ? "available" : "unknown", version: machine.version, updatedAt: machine.updatedAt, endsAt: run?.endsAt ?? null, called: machine.ticketId !== null };
  });
}
export function queueSnapshot(state: QueueState, actor: QueueActor | null, now: number): QueueSnapshot {
  return { serverTime: now, paused: state.paused, machines: publicQueueMachines(state), counts: { washer: state.tickets.filter((t) => t.type === "washer" && ["waiting", "called"].includes(t.state)).length, dryer: state.tickets.filter((t) => t.type === "dryer" && ["waiting", "called"].includes(t.state)).length },
    tickets: actor ? state.tickets.filter((t) => t.userId === actor.id).sort((a, b) => b.sequence - a.sequence).map(({ userId: _userId, callRunId: _callRunId, callAcceptedAt: _acceptedAt, ...ticket }) => ({ ...ticket, ahead: ["waiting", "preparing", "paused"].includes(ticket.state) ? state.tickets.filter((t) => t.type === ticket.type && t.state === "waiting" && t.sequence < ticket.sequence).length : null })) : [],
    runs: actor ? state.runs.filter((r) => r.userId === actor.id).map(({ userId: _userId, ticketId: _ticketId, pickupNoticeCreated: _notice, pickupGeneration: _generation, ...run }) => run) : [],
    reports: actor ? state.reports.filter((r) => actor.isAdmin || r.userId === actor.id || r.ownerId === actor.id).map(({ userId, ownerId, callId: _callId, ...report }) => ({ ...report, role: ownerId === actor.id ? "owner" : userId === actor.id ? "reporter" : "admin", ...(actor.isAdmin ? { reporterId: userId, ownerId, callId: _callId } : {}) })) : [] };
}
