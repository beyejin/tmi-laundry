import { env } from "cloudflare:workers";
import { finishLogin } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    return await finishLogin(request, env.DB, env);
  } catch {
    return Response.json({ error: "로그인을 처리하지 못했어요. 잠시 후 다시 시도해 주세요." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
