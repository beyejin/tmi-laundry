import { findMachine, mutationQuery, parseCommand, type StateRow } from "@/lib/laundry";
import { database, errorResponse, logEvent, readJsonBody, snapshotResponse } from "@/lib/laundry-store";
import { hashToken, turnQuery } from "@/lib/waitlist";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const machine = findMachine(id);
  if (!machine) return errorResponse("등록되지 않은 기기예요.", 404);
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const command = parseCommand(body.value);
  if (!command) return errorResponse("남은 시간은 1분부터 180분까지 입력해 주세요.", 400);
  try {
    const db = database();
    const now = Date.now();
    // 시간 수정 기록(예상과 실제 차이)에 쓸 변경 전 행이에요. 읽기 실패가 요청을 막지 않게 해요.
    const previous = command.action === "adjust" ? await db.prepare("SELECT ends_at, version FROM machine_state WHERE id = ?1").bind(machine.id).first<Pick<StateRow, "ends_at" | "version">>().catch(() => null) : null;
    const query = mutationQuery(machine.id, command, now);
    const start = db.prepare(query.sql).bind(...query.values);
    const turn = machine.type === "dryer" && command.action === "start" && command.waitlist;
    let updated: StateRow | null;
    let waitlistRemoved = false;
    if (turn) {
      const removal = turnQuery({ entryId: turn.id, ownerHash: await hashToken(turn.token), locationId: machine.locationId, machineId: machine.id, newVersion: command.expectedVersion + 1, now });
      const [started, removed] = await db.batch([start, db.prepare(removal.sql).bind(...removal.values)]);
      updated = (started.results[0] as StateRow | undefined) ?? null;
      waitlistRemoved = removed.results.length > 0;
    } else {
      updated = await start.first<StateRow>();
    }
    if (!updated) return errorResponse("다른 등록이 먼저 반영됐어요. 최신 현황을 확인하고 다시 시도해 주세요.", 409);
    const prevRemainingSec = command.action === "adjust" && previous && previous.version === command.expectedVersion && previous.ends_at !== null ? Math.round((previous.ends_at - now) / 1000) : null;
    await logEvent({ kind: command.action, locationId: machine.locationId, machineId: machine.id, at: now, minutes: command.action === "start" ? machine.defaultMinutes : command.action === "adjust" ? command.minutes : null, prevRemainingSec });
    if (waitlistRemoved) await logEvent({ kind: "waitlist_turn", locationId: machine.locationId, machineId: machine.id, at: now });
    return await snapshotResponse(waitlistRemoved ? { waitlistRemoved: true } : {});
  } catch (error) {
    console.error("Laundry update failed", error);
    return errorResponse("등록 결과를 확인하지 못했어요. 현황을 새로고침해 주세요.", 503);
  }
}
