import { env } from "cloudflare:workers";
import { getCurrentUser } from "@/lib/auth";
import { errorResponse } from "@/lib/laundry-store";
import { queueEnabled } from "@/lib/queue-config";
import { getAdminQueueSnapshot } from "@/lib/queue-store";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  if (!queueEnabled(env)) return errorResponse("대기제 시범 운영을 준비하고 있어요.", 503);
  const user = await getCurrentUser(request, env.DB, env);
  if (!user?.isAdmin) return errorResponse("운영자만 확인할 수 있어요.", 403);
  return Response.json(await getAdminQueueSnapshot(env.DB, user), { headers: { "Cache-Control": "no-store" } });
}
