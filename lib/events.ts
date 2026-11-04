// C·D에서 report, service_on, service_off, admin_reset, admin_remove, waitlist_skip을 추가해요.
export const EVENT_KINDS = ["start", "adjust", "clear", "waitlist_join", "waitlist_leave", "waitlist_turn"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export type EventInput = { kind: EventKind; locationId: string; machineId?: string | null; minutes?: number | null; prevRemainingSec?: number | null; at?: number };

export const EVENT_RETENTION_MS = 120 * 24 * 60 * 60_000;

// 별명, 토큰, IP, User-Agent는 기록하지 않아요. 이용 횟수와 시간대 통계에 필요한 값만 남겨요.
export function eventInsert(event: EventInput, now = Date.now()) {
  return {
    sql: "INSERT INTO event_log (at, kind, location_id, machine_id, minutes, prev_remaining_sec) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    values: [event.at ?? now, event.kind, event.locationId, event.machineId ?? null, event.minutes ?? null, event.prevRemainingSec ?? null],
  };
}

/** 보관 기간(120일)이 정확히 지난 기록부터 지워요. */
export function eventCleanupQuery(now: number) {
  return { sql: "DELETE FROM event_log WHERE at <= ?1", values: [now - EVENT_RETENTION_MS] };
}
