import { database, errorResponse, snapshotResponse } from "@/lib/laundry-store";
import { expiredCleanupQuery, hashToken, joinQuery, leaveQuery, parseWaitlistCommand } from "@/lib/waitlist";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!request.headers.get("content-type")?.includes("application/json")) return errorResponse("요청 형식을 확인해 주세요.", 415);
  if (request.headers.get("sec-fetch-site") === "cross-site") return errorResponse("세탁실 화면에서 등록해 주세요.", 403);
  let command;
  try {
    const body = await request.text();
    if (body.length > 1024) return errorResponse("요청이 너무 커요.", 413);
    command = parseWaitlistCommand(JSON.parse(body));
  } catch {
    return errorResponse("입력값을 확인해 주세요.", 400);
  }
  if (!command) return errorResponse("별명은 1자부터 12자까지 입력해 주세요.", 400);
  try {
    const db = database();
    const now = Date.now();
    if (command.action === "join") {
      const id = crypto.randomUUID();
      const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
      const cleanup = expiredCleanupQuery(now);
      const insert = joinQuery({ id, locationId: command.locationId, nickname: command.nickname, ownerHash: await hashToken(token) }, now);
      const [, inserted] = await db.batch([db.prepare(cleanup.sql).bind(...cleanup.values), db.prepare(insert.sql).bind(...insert.values)]);
      if (!inserted.results.length) return errorResponse("대기 인원이 가득 찼거나 같은 이름이 이미 있어요.", 409);
      return await snapshotResponse({ joined: { id, token } });
    }
    const query = leaveQuery(command.id, await hashToken(command.token));
    const removed = await db.prepare(query.sql).bind(...query.values).first<{ id: string }>();
    if (!removed) return errorResponse("이미 빠졌거나 내 대기 기록이 아니에요.", 404);
    return await snapshotResponse();
  } catch (error) {
    console.error("Waitlist update failed", error);
    return errorResponse("대기 명단을 확인하지 못했어요. 현황을 새로고침해 주세요.", 503);
  }
}
