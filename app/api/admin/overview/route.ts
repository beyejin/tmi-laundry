import { adminResponse, errorResponse, requireAdmin } from "@/lib/laundry-store";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  try {
    return await adminResponse({ cleanup: true });
  } catch (error) {
    console.error("Admin overview failed", error);
    return errorResponse("현황을 불러오지 못했어요. 잠시 후 다시 확인해 주세요.", 503);
  }
}
