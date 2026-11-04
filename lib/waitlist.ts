import { findLocation, isWaitlistId, isWaitlistToken } from "./laundry.ts";

export const WAITLIST_LIMIT = 8;
export const WAITLIST_TTL_MS = 3 * 60 * 60_000;
export const NICKNAME_MAX = 12;

export type WaitlistCommand =
  | { action: "join"; locationId: string; nickname: string }
  | { action: "leave"; id: string; token: string }
  | { action: "skip"; id: string };
export type WaitlistRow = { id: string; location_id: string; nickname: string; created_at: number };
export type WaitlistEntry = { id: string; locationId: string; nickname: string; createdAt: number };

export function normalizeNickname(value: unknown) {
  if (typeof value !== "string") return null;
  const nickname = value.trim();
  if (nickname.length < 1 || nickname.length > NICKNAME_MAX) return null;
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(nickname)) return null;
  return nickname;
}

export function parseWaitlistCommand(value: unknown): WaitlistCommand | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.action === "join") {
    if (typeof input.locationId !== "string" || !findLocation(input.locationId)) return null;
    const nickname = normalizeNickname(input.nickname);
    return nickname ? { action: "join", locationId: input.locationId, nickname } : null;
  }
  if (input.action === "leave") {
    if (!isWaitlistId(input.id) || !isWaitlistToken(input.token)) return null;
    return { action: "leave", id: input.id, token: input.token };
  }
  if (input.action === "skip") {
    if (!isWaitlistId(input.id)) return null;
    return { action: "skip", id: input.id };
  }
  return null;
}

export const DRYER_SERVICE_MESSAGE = "건조기 점검 중에는 대기 등록을 받지 않아요.";

/** 이 층의 건조기가 전부 점검 중인지 세는 조건이에요. 건조기 ID 목록이 비면 조건을 넣지 않아요. */
function dryersInServiceClause(dryerIds: readonly string[], first: number) {
  if (!dryerIds.length) return null;
  const marks = dryerIds.map((_, index) => `?${first + index}`).join(", ");
  return { sql: `(SELECT COUNT(*) FROM machine_state WHERE id IN (${marks}) AND out_of_service = 1)`, count: `?${first + dryerIds.length}`, values: [...dryerIds, dryerIds.length] };
}

export function joinQuery(entry: { id: string; locationId: string; nickname: string; ownerHash: string }, now: number, dryerIds: readonly string[] = []) {
  const service = dryersInServiceClause(dryerIds, 8);
  return {
    sql: `INSERT INTO waitlist_entry (id, location_id, nickname, owner_hash, created_at) SELECT ?1, ?2, ?3, ?4, ?5 WHERE (SELECT COUNT(*) FROM waitlist_entry WHERE location_id = ?2 AND created_at > ?6) < ?7 AND NOT EXISTS (SELECT 1 FROM waitlist_entry WHERE location_id = ?2 AND nickname = ?3 AND created_at > ?6)${service ? ` AND ${service.sql} < ${service.count}` : ""} RETURNING id`,
    values: [entry.id, entry.locationId, entry.nickname, entry.ownerHash, now, now - WAITLIST_TTL_MS, WAITLIST_LIMIT, ...(service?.values ?? [])],
  };
}

/** join이 거절됐을 때 원인이 점검인지 가리려고 다시 읽어요. 점검 중인 건조기 수를 돌려줘요. */
export function dryersInServiceQuery(dryerIds: readonly string[]) {
  const service = dryersInServiceClause(dryerIds, 1)!;
  return { sql: `SELECT ${service.sql} AS n`, values: dryerIds.slice() };
}

export function leaveQuery(id: string, ownerHash: string) {
  return { sql: "DELETE FROM waitlist_entry WHERE id = ?1 AND owner_hash = ?2 RETURNING id, location_id", values: [id, ownerHash] };
}

/**
 * 건조기 시작과 같은 batch에서 바로 다음 문장으로 실행해요. 지우는 조건은 두 겹이에요.
 * - changes() > 0: D1 batch는 한 연결에서 순서대로 실행되므로 직전 시작 문장이 실제로 행을 바꿨을 때만 지워요.
 *   같은 밀리초에 진 요청은 시작이 0행이라 여기서 걸러져요.
 * - EXISTS: 직전 문장이 맞는 기기 행 상태(version, updated_at)인지 한 번 더 확인해요.
 *   EXISTS만으로는 이긴 요청이 만든 행(version = 기대값+1, updated_at = now)이 진 요청에도 맞아 보여서 부족해요.
 */
export function turnQuery(turn: { entryId: string; ownerHash: string; locationId: string; machineId: string; newVersion: number; now: number }) {
  return {
    sql: "DELETE FROM waitlist_entry WHERE id = ?1 AND owner_hash = ?2 AND location_id = ?3 AND EXISTS (SELECT 1 FROM machine_state WHERE id = ?4 AND version = ?5 AND updated_at = ?6) AND changes() > 0 RETURNING id",
    values: [turn.entryId, turn.ownerHash, turn.locationId, turn.machineId, turn.newVersion, turn.now],
  };
}

export const SKIP_AFTER_MS = 10 * 60_000;
export const SKIP_BUSY_MESSAGE = "건조기가 아직 사용 중이에요.";
export const SKIP_SERVICE_MESSAGE = "건조기 점검 중이에요.";
export const SKIP_CHANGED_MESSAGE = "그 사이 차례가 바뀌었어요.";
export const SKIP_UNCHECKED_MESSAGE = "건너뛰기를 확인하지 못했어요. 잠시 후 다시 시도해 주세요.";
export const SKIP_BAD_ID_MESSAGE = "대기 항목을 확인해 주세요.";
/** 맨 앞 대기자가 바뀔 때만 남기는 내부 표식이에요. 건너뛰기 10분 규칙의 기준 시각으로만 쓰고 통계 표에는 보이지 않아요. */
export const HEAD_CHANGE_KIND = "waitlist_head_change";

type DryerFree = { endsAt: number | null; updatedAt: number | null; outOfService: boolean };

/** 건조기가 비어 있게 된 시각이에요. 사용 중이거나 점검 중이면 null이에요. 행이 없으면(endsAt, updatedAt 모두 null) 처음부터 비어 있던 것으로 봐요. */
export function dryerFreeSince(dryer: DryerFree, now: number): number | null {
  if (dryer.outOfService) return null;
  if (dryer.endsAt !== null) return dryer.endsAt > now ? null : dryer.endsAt;
  return dryer.updatedAt ?? 0;
}

/** 맨 앞 사람의 차례가 실제로 시작된 시각이에요: 등록 시각, 건조기가 빈 시각, 마지막 맨 앞 변동 시각 중 가장 늦은 값. */
export function turnSince(head: { createdAt: number }, freeSince: number, lastChangeAt: number | null): number {
  return Math.max(head.createdAt, freeSince, lastChangeAt ?? 0);
}

/**
 * 맨 앞 대기자를 건너뛸 수 있는지 판정해요. 서버는 같은 규칙을 skipQuery의 DELETE 안에서 강제하고(권위), 이 함수는 화면 표시와 거절 사유 안내용이에요.
 * 건조기는 층의 첫 번째 건조기예요(estimateTurns와 같은 기준). 차례가 된 지 SKIP_AFTER_MS(10분)가 지나야 건너뛸 수 있고, 그 전에는 남은 시간(waitMs)을 돌려줘요.
 */
export function canSkip(input: { head: { createdAt: number }; dryer: DryerFree; lastChangeAt: number | null; now: number }): { ok: true } | { ok: false; reason: "busy" | "service" | "wait"; waitMs?: number } {
  if (input.dryer.outOfService) return { ok: false, reason: "service" };
  const free = dryerFreeSince(input.dryer, input.now);
  if (free === null) return { ok: false, reason: "busy" };
  const waitMs = turnSince(input.head, free, input.lastChangeAt) + SKIP_AFTER_MS - input.now;
  return waitMs > 0 ? { ok: false, reason: "wait", waitMs } : { ok: true };
}

/** 층의 맨 앞 대기자예요. waitlistSnapshot과 같은 정렬(created_at, id)과 만료 조건을 써요. */
export function headQuery(locationId: string, now: number) {
  return { sql: "SELECT id, location_id, nickname, created_at FROM waitlist_entry WHERE location_id = ?1 AND created_at > ?2 ORDER BY created_at, id LIMIT 1", values: [locationId, now - WAITLIST_TTL_MS] };
}

/** 지우기 전에 읽어 두는 항목의 층과 등록 시각이에요. 항목은 바뀌지 않으므로(불변) 지우는 batch와 사이에 값이 달라질 수 없어요. */
export function entryMetaQuery(id: string) {
  return { sql: "SELECT location_id, created_at FROM waitlist_entry WHERE id = ?1", values: [id] };
}

/**
 * 층별 마지막 맨 앞 변동 시각이에요. 기록된 waitlist_head_change의 최댓값과, 아직 정리되지 않은 만료 행의 만료 시각(가장 늦은 등록 시각 + TTL) 중 늦은 값이에요.
 * 만료 행은 항상 줄의 맨 앞이므로 만료가 곧 맨 앞 변동이에요.
 */
export function lastChangeQuery(now: number) {
  return {
    sql: `SELECT location_id, MAX(at) AS last_at FROM (SELECT location_id, at FROM event_log WHERE kind = '${HEAD_CHANGE_KIND}' AND at > ?1 UNION ALL SELECT location_id, MAX(created_at) + ?2 AS at FROM waitlist_entry WHERE created_at <= ?1 GROUP BY location_id) GROUP BY location_id`,
    values: [now - WAITLIST_TTL_MS, WAITLIST_TTL_MS],
  };
}

/**
 * 직전 DELETE가 맨 앞 항목을 실제로 지웠을 때만 맨 앞 변동 표식을 남겨요. 반드시 batch에서 DELETE 바로 다음 문장이어야 해요(changes()는 직전 문장 기준).
 * 지운 항목보다 앞선(등록이 빠른) 유효한 항목이 남아 있지 않으면 지운 항목이 맨 앞이었던 거예요. 이미 만료된 항목이면 만료 때 따로 기록되므로 여기서는 남기지 않아요.
 */
export function headChangeAfterDeleteQuery(change: { locationId: string; entryId: string; entryCreatedAt: number; now: number }) {
  return {
    sql: `INSERT INTO event_log (at, kind, location_id) SELECT ?1, '${HEAD_CHANGE_KIND}', ?2 WHERE changes() > 0 AND ?4 > ?3 AND NOT EXISTS (SELECT 1 FROM waitlist_entry WHERE location_id = ?2 AND created_at > ?3 AND (created_at < ?4 OR (created_at = ?4 AND id < ?5)))`,
    values: [change.now, change.locationId, change.now - WAITLIST_TTL_MS, change.entryCreatedAt, change.entryId],
  };
}

/** 만료된 행이 정리되기 직전에, 층별로 가장 늦은 만료 시각을 맨 앞 변동으로 기록해요. 정리 DELETE보다 먼저 실행해야 해요. */
export function expireHeadChangeQuery(now: number) {
  return {
    sql: `INSERT INTO event_log (at, kind, location_id) SELECT MAX(created_at) + ?2, '${HEAD_CHANGE_KIND}', location_id FROM waitlist_entry WHERE created_at <= ?1 GROUP BY location_id`,
    values: [now - WAITLIST_TTL_MS, WAITLIST_TTL_MS],
  };
}

/**
 * 건너뛰기: 시간 규칙까지 포함해 SQL이 전부 강제해요(canSkip과 같은 판정). 지우는 조건은
 * - 요청한 항목이 층의 맨 앞(만료 제외)이고 등록한 지 SKIP_AFTER_MS 이상,
 * - 건조기가 점검 중이 아니고, 끝난 지(또는 마지막 변경 후) SKIP_AFTER_MS 이상 지났으며 사용 중이 아님,
 * - 최근 SKIP_AFTER_MS 안에 맨 앞 변동 표식이 없고, 최근 SKIP_AFTER_MS 안에 만료된 행도 없음(아직 정리 전인 만료도 맨 앞 변동이에요).
 * 동시에 여러 건너뛰기가 와도 먼저 지운 쪽이 표식을 남기므로 뒤따르는 요청은 SQL에서 거절돼요.
 */
export function skipQuery(skip: { id: string; locationId: string; dryerId: string }, now: number) {
  return {
    sql: `DELETE FROM waitlist_entry WHERE id = ?1 AND location_id = ?2 AND id = (SELECT id FROM waitlist_entry WHERE location_id = ?2 AND created_at > ?3 ORDER BY created_at, id LIMIT 1) AND created_at <= ?5 AND NOT EXISTS (SELECT 1 FROM machine_state WHERE id = ?4 AND (out_of_service = 1 OR (ends_at IS NOT NULL AND ends_at > ?5) OR (ends_at IS NULL AND updated_at > ?5))) AND NOT EXISTS (SELECT 1 FROM event_log WHERE location_id = ?2 AND kind = '${HEAD_CHANGE_KIND}' AND at > ?5) AND NOT EXISTS (SELECT 1 FROM waitlist_entry WHERE location_id = ?2 AND created_at <= ?3 AND created_at > ?6) RETURNING id`,
    values: [skip.id, skip.locationId, now - WAITLIST_TTL_MS, skip.dryerId, now - SKIP_AFTER_MS, now - WAITLIST_TTL_MS - SKIP_AFTER_MS],
  };
}

/** 건너뛰기 통계 기록이에요. batch에서 맨 앞 변동 표식 INSERT 바로 다음에 실행해요(표식이 들어갔을 때만). */
export function skipStatsAfterHeadChangeQuery(locationId: string, now: number) {
  return { sql: "INSERT INTO event_log (at, kind, location_id) SELECT ?1, 'waitlist_skip', ?2 WHERE changes() > 0", values: [now, locationId] };
}

export function expiredCleanupQuery(now: number) {
  return { sql: "DELETE FROM waitlist_entry WHERE created_at <= ?1", values: [now - WAITLIST_TTL_MS] };
}

export function waitlistSnapshot(rows: WaitlistRow[], now: number): WaitlistEntry[] {
  return rows
    .filter((row) => row.created_at > now - WAITLIST_TTL_MS)
    .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((row) => ({ id: row.id, locationId: row.location_id, nickname: row.nickname, createdAt: row.created_at }));
}

// 사용자가 등록한 종료 시각과 기본 이용 시간으로 계산한 추정값이에요. 실제 수거 여부나 기기 상태는 반영하지 않아요.
export function estimateTurns(dryer: { endsAt: number | null; defaultMinutes: number }, count: number, now: number) {
  const first = dryer.endsAt !== null && dryer.endsAt > now ? dryer.endsAt : now;
  return Array.from({ length: Math.max(0, count) }, (_, index) => first + index * dryer.defaultMinutes * 60_000);
}

export async function hashToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
