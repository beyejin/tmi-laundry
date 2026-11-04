import { env } from "cloudflare:workers";
import { getCurrentUser, isSameOrigin } from "@/lib/auth";
import { errorResponse } from "@/lib/laundry-store";
import { allowedPushEndpoint, parsePushSubscription } from "@/lib/push-validation";
import { hasPushSubscription, pushConfigured, savePushSubscription } from "@/lib/push";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const user = await getCurrentUser(request, env.DB, env);
  const endpoint = new URL(request.url).searchParams.get("endpoint");
  const subscribed = Boolean(user && endpoint && allowedPushEndpoint(endpoint) && await hasPushSubscription(env.DB, user.id, endpoint));
  return Response.json({ configured: pushConfigured(env), publicKey: env.VAPID_PUBLIC_KEY ?? null, subscribed }, { headers: { "Cache-Control": "no-store" } });
}
async function update(request: Request, remove: boolean) {
  const text = await request.text();
  if (!isSameOrigin(request, env)) return errorResponse("세탁실 화면에서 다시 시도해 주세요.", 403);
  if (!request.headers.get("content-type")?.includes("application/json")) return errorResponse("요청 형식을 확인해 주세요.", 415);
  if (text.length > 8192) return errorResponse("요청이 너무 커요.", 413);
  const user = await getCurrentUser(request, env.DB, env);
  if (!user) return errorResponse("학교 Google 계정으로 로그인해 주세요.", 401);
  let body;
  try { body = JSON.parse(text); } catch { return errorResponse("입력값을 확인해 주세요.", 400); }
  if (remove) {
    if (!allowedPushEndpoint(body?.endpoint)) return errorResponse("알림 주소를 확인해 주세요.", 400);
    await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?").bind(body.endpoint, user.id).run();
  } else {
    if (!pushConfigured(env)) return errorResponse("운영자가 알림 설정을 준비하고 있어요.", 503);
    const subscription = parsePushSubscription(body?.subscription);
    if (!subscription) return errorResponse("이 브라우저의 알림을 다시 설정해 주세요.", 400);
    if (!await savePushSubscription(env.DB, user.id, subscription)) return errorResponse("이 브라우저의 이전 계정 알림을 해제하거나 등록한 기기 수를 확인해 주세요. 최대 5개예요.", 409);
  }
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
export function POST(request: Request) { return update(request, false); }
export function DELETE(request: Request) { return update(request, true); }
