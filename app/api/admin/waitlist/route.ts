import { adminRemoveQuery, parseAdminWaitlistCommand } from "@/lib/admin";
import { adminResponse, database, errorResponse, logEvent, readJsonBody, requireAdmin } from "@/lib/laundry-store";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const command = parseAdminWaitlistCommand(body.value);
  if (!command) return errorResponse("삭제할 대기 항목을 확인해 주세요.", 400);
  try {
    const now = Date.now();
    const query = adminRemoveQuery(command.id);
    const removed = await database().prepare(query.sql).bind(...query.values).first<{ id: string; location_id: string }>();
    if (!removed) return errorResponse("이미 빠진 대기 항목이에요.", 404);
    await logEvent({ kind: "admin_remove", locationId: removed.location_id, at: now });
    return await adminResponse();
  } catch (error) {
    console.error("Admin waitlist update failed", error);
    return errorResponse("처리 결과를 확인하지 못했어요. 현황을 새로고침해 주세요.", 503);
  }
}
