export const EVENT_KINDS = ["start", "adjust", "clear", "waitlist_join", "waitlist_leave", "waitlist_turn", "report", "service_on", "service_off", "admin_reset", "admin_remove", "waitlist_skip"] as const;
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

export const REPORT_LIMIT = 3;
export const REPORT_WINDOW_MS = 10 * 60_000;

/** 기기당 10분에 3건까지만 받아요. 기록이 본 기능이라 logEvent가 아니라 직접 실행해요. */
export function reportQuery(machine: { id: string; locationId: string }, now: number) {
  return {
    sql: "INSERT INTO event_log (at, kind, location_id, machine_id) SELECT ?1, 'report', ?2, ?3 WHERE (SELECT COUNT(*) FROM event_log WHERE machine_id = ?3 AND kind = 'report' AND at > ?1 - ?4) < ?5 RETURNING id",
    values: [now, machine.locationId, machine.id, REPORT_WINDOW_MS, REPORT_LIMIT],
  };
}
