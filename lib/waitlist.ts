import { findLocation, isWaitlistId, isWaitlistToken } from "./laundry.ts";

export const WAITLIST_LIMIT = 8;
export const WAITLIST_TTL_MS = 3 * 60 * 60_000;
export const NICKNAME_MAX = 12;

export type WaitlistCommand =
  | { action: "join"; locationId: string; nickname: string }
  | { action: "leave"; id: string; token: string };
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
