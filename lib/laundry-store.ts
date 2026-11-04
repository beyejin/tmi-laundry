import { env } from "cloudflare:workers";
import { eventInsert, type EventInput } from "./events";
import { stateSnapshot, type StateRow } from "./laundry";
import { WAITLIST_TTL_MS, waitlistSnapshot, type WaitlistRow } from "./waitlist";

export function database() {
  if (!env.DB) throw new Error("Laundry database is unavailable");
  return env.DB;
}

export async function readSnapshot() {
  const now = Date.now();
  const db = database();
  const [machines, waitlist] = await db.batch([
    db.prepare("SELECT id, ends_at, updated_at, version FROM machine_state"),
    db.prepare("SELECT id, location_id, nickname, created_at FROM waitlist_entry WHERE created_at > ?1").bind(now - WAITLIST_TTL_MS),
  ]);
  return { ...stateSnapshot(machines.results as StateRow[], now), waitlist: waitlistSnapshot(waitlist.results as WaitlistRow[], now) };
}

export async function snapshotResponse(extra: Record<string, unknown> = {}) {
  return Response.json({ ...(await readSnapshot()), ...extra }, { headers: { "Cache-Control": "no-store" } });
}

export function errorResponse(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
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
