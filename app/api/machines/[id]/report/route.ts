import { reportQuery } from "@/lib/events";
import { findMachine } from "@/lib/laundry";
import { database, errorResponse, readJsonBody } from "@/lib/laundry-store";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const machine = findMachine(id);
  if (!machine) return errorResponse("등록되지 않은 기기예요.", 404);
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  if (!body.value || typeof body.value !== "object" || Array.isArray(body.value)) return errorResponse("입력값을 확인해 주세요.", 400);
  try {
    const query = reportQuery(machine, Date.now());
    // 신고 기록이 이 기능의 본체라 logEvent로 삼키지 않고 직접 실행해요.
    const inserted = await database().prepare(query.sql).bind(...query.values).first<{ id: number }>();
    if (!inserted) return errorResponse("이미 신고가 접수됐어요. 관리자가 확인할 거예요.", 429);
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Machine report failed", error);
    return errorResponse("신고를 접수하지 못했어요. 잠시 후 다시 시도해 주세요.", 503);
  }
}
