import { errorResponse, snapshotResponse } from "@/lib/laundry-store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return await snapshotResponse();
  } catch (error) {
    console.error("Laundry read failed", error);
    return errorResponse("현황을 불러오지 못했어요. 잠시 후 다시 확인해 주세요.", 503);
  }
}
