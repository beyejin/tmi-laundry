import { parseAdminMachineCommand, resetQuery, serviceQuery } from "@/lib/admin";
import { findMachine } from "@/lib/laundry";
import { adminResponse, database, errorResponse, logEvent, readJsonBody, requireAdmin } from "@/lib/laundry-store";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  const { id } = await context.params;
  const machine = findMachine(id);
  if (!machine) return errorResponse("등록되지 않은 기기예요.", 404);
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const command = parseAdminMachineCommand(body.value);
  if (!command) return errorResponse("점검 메모는 40자 이하의 한 줄로 입력해 주세요.", 400);
  try {
    const now = Date.now();
    const query = command.action === "service" ? serviceQuery(machine.id, command.on, command.note, now) : resetQuery(machine.id, now);
    await database().prepare(query.sql).bind(...query.values).run();
    await logEvent({ kind: command.action === "reset" ? "admin_reset" : command.on ? "service_on" : "service_off", locationId: machine.locationId, machineId: machine.id, at: now });
    return await adminResponse();
  } catch (error) {
    console.error("Admin machine update failed", error);
    return errorResponse("처리 결과를 확인하지 못했어요. 현황을 새로고침해 주세요.", 503);
  }
}
