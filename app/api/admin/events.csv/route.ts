import { CSV_HEADER, CSV_MAX_ROWS, csvLine, csvQuery, parseCsvRange, type EventRow } from "@/lib/admin";
import { database, errorResponse, requireAdmin } from "@/lib/laundry-store";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const range = parseCsvRange(params.get("from"), params.get("to"), Date.now());
  if (!range.ok) return errorResponse(range.error, 400);
  try {
    const query = csvQuery(range.fromAt, range.toAt);
    const { results } = await database().prepare(query.sql).bind(...query.values).all<EventRow>();
    // 엑셀이 한글과 UTF-8을 알아보도록 BOM을 앞에 붙여요. 별명과 토큰은 기록에 없어요.
    const truncated = results.length > CSV_MAX_ROWS;
    const rows = truncated ? results.slice(0, CSV_MAX_ROWS) : results;
    const body = `﻿${[CSV_HEADER, ...rows.map(csvLine)].join("\r\n")}\r\n`;
    return new Response(body, { headers: { ...(truncated ? { "X-Truncated": "1" } : {}), "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="tmi-laundry-events-${range.from}_${range.to}.csv"`, "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Admin CSV failed", error);
    return errorResponse("기록을 내려받지 못했어요. 잠시 후 다시 시도해 주세요.", 503);
  }
}
