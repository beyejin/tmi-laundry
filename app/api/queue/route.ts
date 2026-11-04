import { env, waitUntil } from "cloudflare:workers";
import { getCurrentUser, isSameOrigin } from "@/lib/auth";
import { errorResponse } from "@/lib/laundry-store";
import { queueEnabled } from "@/lib/queue-config";
import { QueueError, parseQueueCommand } from "@/lib/queue-engine";
import { executeQueueCommand, getQueueSnapshot } from "@/lib/queue-store";
import { hasPushSubscription, processPushOutbox, pushConfigured } from "@/lib/push";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    if (!queueEnabled(env)) return Response.json({ enabled: false }, { headers: { "Cache-Control": "no-store" } });
    const user = await getCurrentUser(request, env.DB, env);
    const snapshot = await getQueueSnapshot(env.DB, user);
    waitUntil(processPushOutbox(env.DB, env).catch(() => console.error("Queue notification processing failed")));
    return Response.json({ enabled: true, ...snapshot }, { headers: { "Cache-Control": "no-store" } });
  } catch { return errorResponse("대기 현황을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.", 503); }
}
export async function POST(request: Request) {
  const body = await request.text();
  if (!queueEnabled(env)) return errorResponse("대기제 시범 운영을 준비하고 있어요.", 503);
  if (!isSameOrigin(request, env)) return errorResponse("세탁실 화면에서 다시 시도해 주세요.", 403);
  if (!request.headers.get("content-type")?.includes("application/json")) return errorResponse("요청 형식을 확인해 주세요.", 415);
  if (body.length > 4096) return errorResponse("요청이 너무 커요.", 413);
  let command;
  try { command = parseQueueCommand(JSON.parse(body)); } catch { /* Invalid JSON is handled below. */ }
  if (!command) return errorResponse("입력값을 확인해 주세요.", 400);
  try {
    const user = await getCurrentUser(request, env.DB, env);
    if (!user) return errorResponse("학교 Google 계정으로 로그인해 주세요.", 401);
    if ((command.action === "join" || command.action === "ready") && (!pushConfigured(env) || !await hasPushSubscription(env.DB, user.id)))
      return errorResponse("대기 참여 전에 이 기기의 알림 설정을 완료해 주세요.", 409);
    const snapshot = await executeQueueCommand(env.DB, user, command);
    waitUntil(processPushOutbox(env.DB, env).catch(() => console.error("Queue notification processing failed")));
    return Response.json({ enabled: true, ...snapshot }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof QueueError) return errorResponse(error.message, error.status);
    console.error("Queue command failed");
    return errorResponse("처리 결과를 확인하지 못했어요. 새로고침한 뒤 다시 시도해 주세요.", 503);
  }
}
