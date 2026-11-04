import { database, errorResponse, logEvent, readJsonBody, readWaitlistLastChange, snapshotResponse } from "@/lib/laundry-store";
import { MACHINES, type StateRow } from "@/lib/laundry";
import { DRYER_SERVICE_MESSAGE, SKIP_AFTER_MS, SKIP_BUSY_MESSAGE, SKIP_CHANGED_MESSAGE, SKIP_SERVICE_MESSAGE, canSkip, dryersInServiceQuery, expiredCleanupQuery, hashToken, headQuery, joinQuery, leaveQuery, parseWaitlistCommand, skipQuery, type WaitlistRow } from "@/lib/waitlist";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const command = parseWaitlistCommand(body.value);
  if (!command) return errorResponse("별명은 1자부터 12자까지 입력해 주세요.", 400);
  try {
    const db = database();
    const now = Date.now();
    if (command.action === "join") {
      const id = crypto.randomUUID();
      const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
      const dryerIds = MACHINES.filter((machine) => machine.locationId === command.locationId && machine.type === "dryer").map((machine) => machine.id);
      const cleanup = expiredCleanupQuery(now);
      const insert = joinQuery({ id, locationId: command.locationId, nickname: command.nickname, ownerHash: await hashToken(token) }, now, dryerIds);
      const [, inserted] = await db.batch([db.prepare(cleanup.sql).bind(...cleanup.values), db.prepare(insert.sql).bind(...insert.values)]);
      if (!inserted.results.length) {
        // 건조기가 모두 점검 중이라 거절됐는지 다시 읽어 구분해요.
        const service = dryerIds.length ? await db.prepare(dryersInServiceQuery(dryerIds).sql).bind(...dryerIds).first<{ n: number }>().catch(() => null) : null;
        if (service && service.n >= dryerIds.length) return errorResponse(DRYER_SERVICE_MESSAGE, 409, { reason: "service" });
        return errorResponse("대기 인원이 가득 찼거나 같은 이름이 이미 있어요.", 409);
      }
      await logEvent({ kind: "waitlist_join", locationId: command.locationId, at: now });
      return await snapshotResponse({ joined: { id, token } });
    }
    if (command.action === "skip") return await skip(command.id, now);
    const query = leaveQuery(command.id, await hashToken(command.token));
    const removed = await db.prepare(query.sql).bind(...query.values).first<{ id: string; location_id: string }>();
    if (!removed) return errorResponse("이미 빠졌거나 내 대기 기록이 아니에요.", 404);
    await logEvent({ kind: "waitlist_leave", locationId: removed.location_id, at: now });
    return await snapshotResponse();
  } catch (error) {
    console.error("Waitlist update failed", error);
    return errorResponse("대기 명단을 확인하지 못했어요. 현황을 새로고침해 주세요.", 503);
  }
}

/** 맨 앞 대기자를 건너뛰어요. 누구나 할 수 있고(토큰 없음), 차례가 된 지 10분이 지나야 해요. 판정 규칙은 화면과 같은 canSkip이에요. */
async function skip(id: string, now: number) {
  const db = database();
  const entry = await db.prepare("SELECT id, location_id FROM waitlist_entry WHERE id = ?1").bind(id).first<{ id: string; location_id: string }>();
  if (!entry) return errorResponse(SKIP_CHANGED_MESSAGE, 409);
  const dryer = MACHINES.find((machine) => machine.locationId === entry.location_id && machine.type === "dryer");
  if (!dryer) return errorResponse(SKIP_CHANGED_MESSAGE, 409);
  const head = headQuery(entry.location_id, now);
  const [headResult, dryerResult] = await db.batch([db.prepare(head.sql).bind(...head.values), db.prepare("SELECT id, ends_at, updated_at, version, out_of_service, service_note FROM machine_state WHERE id = ?1").bind(dryer.id)]);
  const first = headResult.results[0] as WaitlistRow | undefined;
  if (!first || first.id !== id) return errorResponse(SKIP_CHANGED_MESSAGE, 409);
  const row = dryerResult.results[0] as StateRow | undefined;
  const lastChange = (await readWaitlistLastChange(now))[entry.location_id] ?? null;
  const verdict = canSkip({ head: { createdAt: first.created_at }, dryer: { endsAt: row?.ends_at ?? null, updatedAt: row?.updated_at ?? null, outOfService: Boolean(row?.out_of_service) }, lastChangeAt: lastChange, now });
  if (!verdict.ok) {
    if (verdict.reason === "busy") return errorResponse(SKIP_BUSY_MESSAGE, 409);
    if (verdict.reason === "service") return errorResponse(SKIP_SERVICE_MESSAGE, 409);
    return errorResponse(`차례가 된 지 ${SKIP_AFTER_MS / 60_000}분이 지나야 건너뛸 수 있어요. 약 ${Math.ceil((verdict.waitMs ?? 0) / 60_000)}분 남았어요.`, 409);
  }
  const query = skipQuery({ id, locationId: entry.location_id, dryerId: dryer.id }, now);
  const removed = await db.prepare(query.sql).bind(...query.values).first<{ id: string }>();
  if (!removed) return errorResponse(SKIP_CHANGED_MESSAGE, 409);
  await logEvent({ kind: "waitlist_skip", locationId: entry.location_id, at: now });
  return await snapshotResponse();
}
