import { isWaitlistId } from "./laundry.ts";

export const ADMIN_TOKEN_MIN_LENGTH = 24;
export const DAY_MS = 24 * 60 * 60_000;
export const KST_OFFSET_MS = 9 * 60 * 60_000;
export const SERVICE_NOTE_MAX = 40;
export const CSV_MAX_DAYS = 180;
export const CSV_MAX_ROWS = 50_000;
export const CSV_HEADER = "at_kst,kind,location_id,machine_id,minutes,prev_remaining_sec";

type Compare = (a: Uint8Array, b: Uint8Array) => boolean;

/** 길이가 같을 때 모든 바이트를 훑어 비교해요. 워커에는 crypto.subtle.timingSafeEqual이 있어 그것을 먼저 쓰고, 없는 Node 같은 곳에서는 상수 시간 루프를 써요. */
export function safeEqualBytes(a: Uint8Array, b: Uint8Array, native?: Compare | null) {
  if (a.length !== b.length) return false;
  if (native) return native(a, b);
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

async function sha256(value: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function nativeCompare(): Compare | null {
  const subtle = crypto.subtle as unknown as { timingSafeEqual?: Compare };
  return typeof subtle.timingSafeEqual === "function" ? (a, b) => subtle.timingSafeEqual!.call(crypto.subtle, a, b) : null;
}

/** ADMIN_TOKEN이 없거나 24자 미만이면 관리자 기능 전체가 꺼져요. 두 값을 SHA-256으로 길이를 맞춘 뒤 비교해요. */
export async function isAdmin(request: Request, expected: string | undefined, compare: Compare | null = nativeCompare()) {
  if (!expected || expected.length < ADMIN_TOKEN_MIN_LENGTH) return false;
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  return safeEqualBytes(a, b, compare);
}

export type AdminMachineCommand = { action: "service"; on: boolean; note: string | null } | { action: "reset" };

/** 점검 메모: 앞뒤 공백 제거, 0~40자, 제어문자 금지. 빈 문자열은 메모 없음이에요. */
export function normalizeServiceNote(value: unknown): { ok: true; note: string | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, note: null };
  if (typeof value !== "string") return { ok: false };
  const note = value.trim();
  if (note.length > SERVICE_NOTE_MAX || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(note)) return { ok: false };
  return { ok: true, note: note || null };
}

export function parseAdminMachineCommand(value: unknown): AdminMachineCommand | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.action === "reset") return { action: "reset" };
  if (input.action !== "service" || typeof input.on !== "boolean") return null;
  const note = normalizeServiceNote(input.note);
  if (!note.ok) return null;
  return { action: "service", on: input.on, note: input.on ? note.note : null };
}

export function parseAdminWaitlistCommand(value: unknown): { action: "remove"; id: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  return input.action === "remove" && isWaitlistId(input.id) ? { action: "remove", id: input.id } : null;
}

/** 점검 전환은 업서트 + version 증가라 다른 화면의 낡은 요청이 409로 막혀요. 점검을 끄면 메모도 지워요. */
export function serviceQuery(id: string, on: boolean, note: string | null, now: number) {
  return {
    sql: "INSERT INTO machine_state (id, ends_at, updated_at, version, out_of_service, service_note) VALUES (?1, NULL, ?2, 1, ?3, ?4) ON CONFLICT(id) DO UPDATE SET out_of_service = ?3, service_note = ?4, ends_at = NULL, updated_at = ?2, version = version + 1 RETURNING *",
    values: [id, now, on ? 1 : 0, on ? note : null],
  };
}

/** 등록 초기화: 행이 없으면 아무 일도 없어요(성공 취급). */
export function resetQuery(id: string, now: number) {
  return { sql: "UPDATE machine_state SET ends_at = NULL, updated_at = ?2, version = version + 1 WHERE id = ?1 RETURNING *", values: [id, now] };
}

export function adminRemoveQuery(id: string) {
  return { sql: "DELETE FROM waitlist_entry WHERE id = ?1 RETURNING id, location_id", values: [id] };
}

/** 한국 표준시(UTC+9, 서머타임 없음) 자정의 UTC 밀리초예요. */
export function kstDayStart(now: number) {
  return Math.floor((now + KST_OFFSET_MS) / DAY_MS) * DAY_MS - KST_OFFSET_MS;
}

export function kstDateString(at: number) {
  return new Date(at + KST_OFFSET_MS).toISOString().slice(0, 10);
}

export function kstDateTimeString(at: number) {
  return new Date(at + KST_OFFSET_MS).toISOString().slice(0, 19).replace("T", " ");
}

export type StatPeriod = "today" | "week" | "all";
export type StatRow = { kind: string; n: number; washer: number | null; dryer: number | null };
export type PeriodStats = { counts: Record<string, number>; washerStarts: number; dryerStarts: number };

export function periodStarts(now: number): Record<StatPeriod, number> {
  return { today: kstDayStart(now), week: now - 7 * DAY_MS, all: 0 };
}

/** kind별 건수와 시작(start)의 세탁기/건조기 수. machine_id에 -washer-/-dryer-가 들어 있는지로 나눠요. */
export function statsQuery(since: number) {
  return {
    sql: "SELECT kind, COUNT(*) AS n, SUM(machine_id LIKE '%-washer-%') AS washer, SUM(machine_id LIKE '%-dryer-%') AS dryer FROM event_log WHERE at >= ?1 GROUP BY kind",
    values: [since],
  };
}

export function summarizeStats(rows: StatRow[]): PeriodStats {
  const counts: Record<string, number> = {};
  let washerStarts = 0;
  let dryerStarts = 0;
  for (const row of rows) {
    counts[row.kind] = row.n;
    if (row.kind === "start") { washerStarts = row.washer ?? 0; dryerStarts = row.dryer ?? 0; }
  }
  return { counts, washerStarts, dryerStarts };
}

/** 최근 7일 시작(start)의 KST 시(0~23)별 건수예요. */
export function hourlyQuery(since: number) {
  return { sql: "SELECT ((at + 32400000) / 3600000) % 24 AS hour, COUNT(*) AS n FROM event_log WHERE kind = 'start' AND at >= ?1 GROUP BY hour", values: [since] };
}

export function hourlyDistribution(rows: { hour: number; n: number }[]) {
  const hours = Array.from({ length: 24 }, () => 0);
  for (const row of rows) if (row.hour >= 0 && row.hour < 24) hours[row.hour] = row.n;
  return hours;
}

export function reportCountsQuery(since: number) {
  return { sql: "SELECT machine_id, COUNT(*) AS n FROM event_log WHERE kind = 'report' AND at >= ?1 GROUP BY machine_id", values: [since] };
}

export function accuracyQuery(since: number) {
  return { sql: "SELECT prev_remaining_sec, minutes FROM event_log WHERE kind = 'adjust' AND prev_remaining_sec IS NOT NULL AND minutes IS NOT NULL AND at >= ?1", values: [since] };
}

/** diffSec = 수정 직전 남은 시간 - 새로 입력한 시간. 양수면 처음 등록한 시간이 실제보다 길었다는 뜻이에요. */
export function summarizeAccuracy(rows: { prev_remaining_sec: number; minutes: number }[]) {
  if (!rows.length) return { count: 0, medianSec: null as number | null, meanAbsSec: null as number | null };
  const diffs = rows.map((row) => row.prev_remaining_sec - row.minutes * 60).sort((a, b) => a - b);
  const middle = Math.floor(diffs.length / 2);
  const medianSec = diffs.length % 2 ? diffs[middle] : (diffs[middle - 1] + diffs[middle]) / 2;
  const meanAbsSec = diffs.reduce((total, diff) => total + Math.abs(diff), 0) / diffs.length;
  return { count: diffs.length, medianSec, meanAbsSec };
}

/** CSV 셀: 쉼표, 따옴표, 줄바꿈이 있으면 따옴표로 감싸요. 문자열이 = + - @ 로 시작하면(숫자는 그대로 둬요) 수식으로 읽히지 않게 앞에 '를 붙여요. */
export function csvCell(value: string | number | null | undefined) {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export type EventRow = { at: number; kind: string; location_id: string; machine_id: string | null; minutes: number | null; prev_remaining_sec: number | null };

export function csvLine(row: EventRow) {
  return [kstDateTimeString(row.at), row.kind, row.location_id, row.machine_id, row.minutes, row.prev_remaining_sec].map(csvCell).join(",");
}

/** from/to는 KST 날짜(YYYY-MM-DD), to를 포함해요. 기본은 오늘까지 최근 30일, 범위는 최대 180일이에요. */
export function parseCsvRange(from: string | null, to: string | null, now: number): { ok: true; from: string; to: string; fromAt: number; toAt: number } | { ok: false; error: string } {
  const toDay = to || kstDateString(now);
  const valid = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && kstDateString(Date.parse(`${value}T00:00:00Z`)) === value;
  if (!valid(toDay)) return { ok: false, error: "날짜는 YYYY-MM-DD 형식으로 입력해 주세요." };
  const fromDay = from || kstDateString(Date.parse(`${toDay}T00:00:00Z`) - 29 * DAY_MS);
  if (!valid(fromDay)) return { ok: false, error: "날짜는 YYYY-MM-DD 형식으로 입력해 주세요." };
  const fromAt = Date.parse(`${fromDay}T00:00:00Z`) - KST_OFFSET_MS;
  const toAt = Date.parse(`${toDay}T00:00:00Z`) - KST_OFFSET_MS + DAY_MS;
  if (toAt <= fromAt) return { ok: false, error: "시작 날짜가 끝 날짜보다 늦어요." };
  if ((toAt - fromAt) / DAY_MS > CSV_MAX_DAYS) return { ok: false, error: `기간은 최대 ${CSV_MAX_DAYS}일까지예요.` };
  return { ok: true, from: fromDay, to: toDay, fromAt, toAt };
}

export function csvQuery(fromAt: number, toAt: number) {
  return { sql: "SELECT at, kind, location_id, machine_id, minutes, prev_remaining_sec FROM event_log WHERE at >= ?1 AND at < ?2 ORDER BY at, id LIMIT ?3", values: [fromAt, toAt, CSV_MAX_ROWS + 1] };
}
