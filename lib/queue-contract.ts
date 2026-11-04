export type QueueType = "washer" | "dryer";
export type QueueActor = { id: string; isAdmin: boolean };
export type TicketState = "preparing" | "waiting" | "called" | "paused" | "in_use" | "pickup" | "completed" | "cancelled" | "expired";
export type MachineQueueStatus = "unknown" | "running" | "check" | "blocked" | "available" | "fault";
export type ReportKind = "uncollected" | "still_running" | "fault";
export type QueueCommand = { requestId: string } & (
  | { action: "join"; type: QueueType }
  | { action: "ready" | "cancel"; ticketId: string }
  | { action: "start"; ticketId: string; callId: string; machineId: string }
  | { action: "pickup"; runId: string; expectedVersion: number }
  | { action: "adjust"; runId: string; expectedVersion: number; minutes: number }
  | { action: "report"; ticketId: string; callId: string; machineId: string; kind: ReportKind }
  | { action: "confirm_empty" | "recover"; machineId: string; expectedVersion: number }
  | { action: "pause" | "resume" }
);
export type QueueMachineView = {
  id: string; type: QueueType; locationId: string; name: string;
  status: MachineQueueStatus; version: number; endsAt: number | null; updatedAt: number; called: boolean;
};
export type QueueTicketView = {
  id: string; type: QueueType; sequence: number; state: TicketState; createdAt: number;
  machineId: string | null; callId: string | null; calledAt: number | null; expiresAt: number | null;
  runId: string | null; ahead: number | null; pauseReason: string | null;
};
export type QueueRunView = {
  id: string; machineId: string; type: QueueType; startedAt: number; endsAt: number;
  collectedAt: number | null; status: "running" | "pickup" | "completed"; version: number;
};
export type QueueReportView = {
  id: string; machineId: string; runId: string; kind: ReportKind; calledAt: number;
  reportedAt: number; expectedEndAt: number | null; resolvedAt: number | null; resolution: string | null;
  role: "owner" | "reporter" | "admin"; reporterId?: string; ownerId?: string | null; callId?: string;
};
export type QueueSnapshot = {
  serverTime: number; paused: boolean; machines: QueueMachineView[]; tickets: QueueTicketView[];
  runs: QueueRunView[]; reports: QueueReportView[]; counts: Record<QueueType, number>;
};
export type NotificationKind = "pickup" | "call" | "uncollected" | "still_running" | "released";
export type QueueNotificationJob = {
  id: string; userId: string; kind: NotificationKind; title: string; body: string; url: string; tag: string;
  ticketId: string | null; callId: string | null; runId: string | null; expiresAt: number | null;
  status: "queued" | "leased" | "sent" | "failed" | "cancelled"; attempts: number;
  nextAttemptAt: number; leaseUntil: number | null; leaseToken: string | null; createdAt: number;
};
export const QUEUE_CALL_MS = 5 * 60_000;
export function isPilotMachine(id: string) { return /^h3-women-[2-5]-(washer-[12]|dryer-1)$/.test(id); }
export function isPilotLocation(id: string) { return /^h3-women-[2-5]$/.test(id); }
