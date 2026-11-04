import { env } from "cloudflare:workers";
import { getCurrentUser, isSameOrigin } from "@/lib/auth";
import { errorResponse } from "@/lib/laundry-store";
import { allowedPushEndpoint } from "@/lib/push-validation";
import { pushConfigured, sendPushTest } from "@/lib/push";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const body = await request.text();
  if (!isSameOrigin(request, env)) return errorResponse("세탁실 화면에서 다시 시도해 주세요.", 403);
  if (body.length > 4096) return errorResponse("요청이 너무 커요.", 413);
  if (!request.headers.get("content-type")?.includes("application/json")) return errorResponse("요청 형식을 확인해 주세요.", 415);
  const user = await getCurrentUser(request, env.DB, env);
  if (!user) return errorResponse("학교 Google 계정으로 로그인해 주세요.", 401);
  if (!pushConfigured(env)) return errorResponse("운영자가 알림 설정을 준비하고 있어요.", 503);
  let endpoint;
  try { endpoint = JSON.parse(body)?.endpoint; } catch { /* Validate below. */ }
  if (!allowedPushEndpoint(endpoint)) return errorResponse("이 브라우저의 알림을 먼저 설정해 주세요.", 400);
  const accepted = await sendPushTest(env.DB, user.id, endpoint, env);
  if (accepted === null) return errorResponse("알림을 등록한 뒤 30초 간격으로 테스트해 주세요.", 429);
  if (!accepted) return errorResponse("알림 서비스가 전송을 받지 못했어요. 알림을 다시 설정해 주세요.", 502);
  return Response.json({ accepted: true, message: "알림 서비스에 전송했어요. 실제 도착 여부를 확인해 주세요." }, { headers: { "Cache-Control": "no-store" } });
}
