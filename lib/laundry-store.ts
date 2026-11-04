import { env } from "cloudflare:workers";
import { accuracyQuery, hourlyDistribution, hourlyQuery, isAdmin, periodStarts, reportCountsQuery, statsQuery, summarizeAccuracy, summarizeStats, DAY_MS, type StatPeriod, type StatRow } from "./admin";
import { eventCleanupQuery, eventInsert, type EventInput } from "./events";
import { stateSnapshot, type StateRow } from "./laundry";
import { WAITLIST_TTL_MS, entryMetaQuery, headChangeAfterDeleteQuery, lastChangeQuery, waitlistSnapshot, type WaitlistRow } from "./waitlist";

export function database() {
  if (!env.DB) throw new Error("Laundry database is unavailable");
  return env.DB;
}

export async function readSnapshot() {
  const now = Date.now();
  const db = database();
  const [machines, waitlist] = await db.batch([
    db.prepare("SELECT id, ends_at, updated_at, version, out_of_service, service_note FROM machine_state"),
    db.prepare("SELECT id, location_id, nickname, created_at FROM waitlist_entry WHERE created_at > ?1").bind(now - WAITLIST_TTL_MS),
  ]);
  return { ...stateSnapshot(machines.results as StateRow[], now), waitlist: waitlistSnapshot(waitlist.results as WaitlistRow[], now), waitlistLastChange: await readWaitlistLastChange(now) };
}

/** 층별 마지막 맨 앞 변동 시각을 읽어요. 실패하면 throw해요: 건너뛰기 판정처럼 틀리면 안 되는 곳에서 써요. */
export async function readWaitlistLastChangeStrict(now: number): Promise<Record<string, number>> {
  const query = lastChangeQuery(now);
  const result = await database().prepare(query.sql).bind(...query.values).all<{ location_id: string; last_at: number }>();
  return Object.fromEntries(result.results.map((row) => [row.location_id, row.last_at]));
}

/**
 * 화면 표시용이에요. 위 batch와 따로 실행해요: event_log가 아직 없는 DB(마이그레이션 0002 전)에서
 * 이 조회가 실패해도 메인 현황 조회는 성공해야 하기 때문이에요. 실패하면 {}를 돌려주고 기록만 남겨요(서버 판정은 SQL이 하므로 표시만 느슨해져요).
 */
export async function readWaitlistLastChange(now: number): Promise<Record<string, number>> {
  try {
    return await readWaitlistLastChangeStrict(now);
  } catch (error) {
    console.error("Waitlist last change read failed", error);
    return {};
  }
}

/** 지우기 전에 읽는 대기 항목의 층과 등록 시각이에요. 항목이 없으면 null(지우는 문장도 아무것도 지우지 않아요). 실패하면 throw해요. */
export async function readEntryMeta(id: string) {
  const query = entryMetaQuery(id);
  return await database().prepare(query.sql).bind(...query.values).first<{ location_id: string; created_at: number }>();
}

/** 직전 문장(DELETE)이 맨 앞 항목을 지웠을 때만 표식을 남기는 prepared statement예요. batch에서 DELETE 바로 다음에 넣어요. */
export function headChangeStatement(entryId: string, meta: { location_id: string; created_at: number }, now: number) {
  const query = headChangeAfterDeleteQuery({ locationId: meta.location_id, entryId, entryCreatedAt: meta.created_at, now });
  return database().prepare(query.sql).bind(...query.values);
}

export async function snapshotResponse(extra: Record<string, unknown> = {}) {
  return Response.json({ ...(await readSnapshot()), ...extra }, { headers: { "Cache-Control": "no-store" } });
}

export function errorResponse(message: string, status: number, extra: Record<string, unknown> = {}) {
  return Response.json({ error: message, ...extra }, { status, headers: { "Cache-Control": "no-store" } });
}

/** POST 공통 가드: 415 content-type, 403 cross-site, 413 1024바이트, 400 JSON 파싱. */
export async function readJsonBody(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  if (!request.headers.get("content-type")?.includes("application/json")) return { ok: false, response: errorResponse("요청 형식을 확인해 주세요.", 415) };
  if (request.headers.get("sec-fetch-site") === "cross-site") return { ok: false, response: errorResponse("세탁실 화면에서 등록해 주세요.", 403) };
  try {
    const body = await request.text();
    if (body.length > 1024) return { ok: false, response: errorResponse("요청이 너무 커요.", 413) };
    return { ok: true, value: JSON.parse(body) };
  } catch {
    return { ok: false, response: errorResponse("입력값을 확인해 주세요.", 400) };
  }
}

/** 이용 기록은 부가 기능이라 실패해도 사용자 요청을 깨뜨리지 않아요. 절대 throw하지 않아요. */
export async function logEvent(event: EventInput) {
  try {
    const query = eventInsert(event);
    await database().prepare(query.sql).bind(...query.values).run();
  } catch (error) {
    console.error("Event log failed", error);
  }
}

/** 모든 /api/admin/* 의 첫 줄에서 불러요. 인증되지 않으면 401 응답을 돌려줘요. ADMIN_TOKEN이 없거나 짧으면 항상 401이에요. */
export async function requireAdmin(request: Request): Promise<Response | null> {
  return (await isAdmin(request, env.ADMIN_TOKEN)) ? null : errorResponse("관리자 인증이 필요해요.", 401);
}

/** 관리자 화면용 현황: 기기 상태 + 24시간 신고 수, 대기 명단(별명 포함, 토큰 제외). stats가 true면 기간별 통계, 시간대 분포, 예상 정확도를 더해요. 가벼운 폴링은 stats: false예요. */
export async function readOverview(options: { cleanup?: boolean; stats?: boolean } = {}) {
  const db = database();
  const now = Date.now();
  const withStats = options.stats !== false;
  if (options.cleanup && withStats) {
    const cleanup = eventCleanupQuery(now);
    await db.prepare(cleanup.sql).bind(...cleanup.values).run().catch((error) => console.error("Event cleanup failed", error));
  }
  const starts = periodStarts(now);
  const reportQ = reportCountsQuery(now - DAY_MS);
  const statQueries = withStats ? [statsQuery(starts.today), statsQuery(starts.week), statsQuery(starts.all), hourlyQuery(now - 7 * DAY_MS), accuracyQuery(now - 30 * DAY_MS)] : [];
  const [machines, waitlist, reports, ...rest] = await db.batch([
    db.prepare("SELECT id, ends_at, updated_at, version, out_of_service, service_note FROM machine_state"),
    db.prepare("SELECT id, location_id, nickname, created_at FROM waitlist_entry WHERE created_at > ?1").bind(now - WAITLIST_TTL_MS),
    db.prepare(reportQ.sql).bind(...reportQ.values),
    ...statQueries.map((query) => db.prepare(query.sql).bind(...query.values)),
  ]);
  const reportCounts = new Map((reports.results as { machine_id: string; n: number }[]).map((row) => [row.machine_id, row.n]));
  const snapshot = stateSnapshot(machines.results as StateRow[], now);
  const base = {
    serverTime: now,
    machines: snapshot.machines.map((machine) => ({ ...machine, reports24h: reportCounts.get(machine.id) ?? 0 })),
    waitlist: waitlistSnapshot(waitlist.results as WaitlistRow[], now),
  };
  if (!withStats) return base;
  const [today, week, all, hourly, accuracy] = rest;
  const periods: Record<StatPeriod, StatRow[]> = { today: today.results as StatRow[], week: week.results as StatRow[], all: all.results as StatRow[] };
  return {
    ...base,
    stats: { today: summarizeStats(periods.today), week: summarizeStats(periods.week), all: summarizeStats(periods.all), hourly7d: hourlyDistribution(hourly.results as { hour: number; n: number }[]) },
    accuracy: summarizeAccuracy(accuracy.results as { prev_remaining_sec: number; minutes: number }[]),
  };
}

export async function adminResponse(options: { cleanup?: boolean; stats?: boolean } = {}) {
  return Response.json(await readOverview(options), { headers: { "Cache-Control": "no-store" } });
}
