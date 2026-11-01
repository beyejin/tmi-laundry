import { findLocation } from "./laundry.ts";

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
    if (typeof input.id !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(input.id)) return null;
    if (typeof input.token !== "string" || input.token.length < 16 || input.token.length > 128) return null;
    return { action: "leave", id: input.id, token: input.token };
  }
  return null;
}

export function joinQuery(entry: { id: string; locationId: string; nickname: string; ownerHash: string }, now: number) {
  return {
    sql: "INSERT INTO waitlist_entry (id, location_id, nickname, owner_hash, created_at) SELECT ?1, ?2, ?3, ?4, ?5 WHERE (SELECT COUNT(*) FROM waitlist_entry WHERE location_id = ?2 AND created_at > ?6) < ?7 AND NOT EXISTS (SELECT 1 FROM waitlist_entry WHERE location_id = ?2 AND nickname = ?3 AND created_at > ?6) RETURNING id",
    values: [entry.id, entry.locationId, entry.nickname, entry.ownerHash, now, now - WAITLIST_TTL_MS, WAITLIST_LIMIT],
  };
}

export function leaveQuery(id: string, ownerHash: string) {
  return { sql: "DELETE FROM waitlist_entry WHERE id = ?1 AND owner_hash = ?2 RETURNING id", values: [id, ownerHash] };
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
