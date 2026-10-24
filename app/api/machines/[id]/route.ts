import { findMachine, mutationQuery, parseCommand, type StateRow } from "@/lib/laundry";
import { database, errorResponse, snapshotResponse } from "@/lib/laundry-store";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const machine = findMachine(id);
  if (!machine) return errorResponse("등록되지 않은 기기예요.", 404);
  if (!request.headers.get("content-type")?.includes("application/json")) return errorResponse("요청 형식을 확인해 주세요.", 415);
  if (request.headers.get("sec-fetch-site") === "cross-site") return errorResponse("세탁실 화면에서 등록해 주세요.", 403);
  let command;
  try {
    const body = await request.text();
    if (body.length > 1024) return errorResponse("요청이 너무 커요.", 413);
    command = parseCommand(JSON.parse(body));
  } catch {
    return errorResponse("입력값을 확인해 주세요.", 400);
  }
  if (!command) return errorResponse("남은 시간은 1분부터 180분까지 입력해 주세요.", 400);
  try {
    const query = mutationQuery(machine.id, command, Date.now());
    const updated = await database().prepare(query.sql).bind(...query.values).first<StateRow>();
    if (!updated) return errorResponse("다른 등록이 먼저 반영됐어요. 최신 현황을 확인하고 다시 시도해 주세요.", 409);
    return await snapshotResponse();
  } catch (error) {
    console.error("Laundry update failed", error);
    return errorResponse("등록 결과를 확인하지 못했어요. 현황을 새로고침해 주세요.", 503);
  }
}
