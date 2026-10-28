export const DONE_ALERT_STORAGE_KEY = "tmi-laundry-done-alerts";
export const FAST_ALERT_DELAY_MS = 10_000;
export const scheduleLabel = "끝나면 알려 주세요";
export const cancelMessage = "알림을 취소했어요";

export type DoneAlertRecord = {
  machineId: string;
  endsAt: number;
  fireAt: number;
  fast: boolean;
  message: string;
};

type AlertStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const digitHasBatchim: Record<string, boolean> = {
  "0": true,
  "1": true,
  "2": false,
  "3": true,
  "4": false,
  "5": false,
  "6": true,
  "7": true,
  "8": true,
  "9": false,
};

export function subjectParticle(name: string) {
  const last = name.trim().slice(-1);
  if (last in digitHasBatchim) return digitHasBatchim[last] ? "이" : "가";
  const code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 === 0 ? "가" : "이";
  return "이";
}

export function doneMessage(locationLabel: string, machineName: string) {
  return `${locationLabel} ${machineName}${subjectParticle(machineName)} 끝났을 거예요`;
}

export function minutesUntil(endsAt: number, now: number) {
  return Math.max(1, Math.ceil((endsAt - now) / 60_000));
}

export function scheduledLabel(minutes: number) {
  return `알림 예약됨 · 약 ${minutes}분 뒤`;
}

export function alertDelay(endsAt: number, now: number, fast: boolean) {
  if (fast) return FAST_ALERT_DELAY_MS;
  return Math.max(0, endsAt - now);
}

export function notificationPermission(): NotificationPermission | "unsupported" {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

export function showDoneNotification(message: string) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    new Notification(message, { lang: "ko" });
  } catch {
    // 브라우저가 알림 생성을 막으면 화면 toast가 같은 문장을 보여 줘요.
  }
}

function isAlertRecord(value: unknown): value is DoneAlertRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<DoneAlertRecord>;
  return typeof record.machineId === "string"
    && record.machineId.length > 0
    && typeof record.endsAt === "number"
    && Number.isFinite(record.endsAt)
    && typeof record.fireAt === "number"
    && Number.isFinite(record.fireAt)
    && typeof record.fast === "boolean"
    && typeof record.message === "string"
    && record.message.length > 0;
}

export function readAlerts(storage: AlertStorage) {
  try {
    const raw = storage.getItem(DONE_ALERT_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const alerts: Record<string, DoneAlertRecord> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!isAlertRecord(value) || value.machineId !== key) continue;
      alerts[key] = value;
    }
    return alerts;
  } catch {
    return {};
  }
}

export function writeAlerts(storage: AlertStorage, alerts: Record<string, DoneAlertRecord>) {
  if (Object.keys(alerts).length === 0) storage.removeItem(DONE_ALERT_STORAGE_KEY);
  else storage.setItem(DONE_ALERT_STORAGE_KEY, JSON.stringify(alerts));
}
