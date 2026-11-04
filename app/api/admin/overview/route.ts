import { adminResponse, errorResponse, requireAdmin } from "@/lib/laundry-store";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  try {
    // stats=0은 30초 폴링용 가벼운 응답(기기, 대기 명단만)이고, 통계와 오래된 기록 정리는 기본값(stats=1)에서만 해요.
    const light = new URL(request.url).searchParams.get("stats") === "0";
    return await adminResponse({ cleanup: !light, stats: !light });
  } catch (error) {
    console.error("Admin overview failed", error);
    return errorResponse("현황을 불러오지 못했어요. 잠시 후 다시 확인해 주세요.", 503);
  }
}
