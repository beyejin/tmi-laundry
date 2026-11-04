export interface PushSubscriptionValue {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}
export function allowedPushEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.href === value && url.protocol === "https:" && !url.username && !url.password && !url.hash && !url.port
      && (url.hostname === "fcm.googleapis.com"
        || url.hostname === "updates.push.services.mozilla.com"
        || url.hostname.endsWith(".push.services.mozilla.com")
        || url.hostname === "web.push.apple.com");
  } catch { return false; }
}
function keyLength(value: unknown, length: number): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return false;
  try { return atob(value.replaceAll("-", "+").replaceAll("_", "/")).length === length; } catch { return false; }
}
export function parsePushSubscription(value: unknown): PushSubscriptionValue | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (!allowedPushEndpoint(v.endpoint) || !v.keys || !keyLength(v.keys.p256dh, 65) || !keyLength(v.keys.auth, 16)) return null;
  if (atob(v.keys.p256dh.replaceAll("-", "+").replaceAll("_", "/")).charCodeAt(0) !== 4) return null;
  return { endpoint: v.endpoint, keys: { p256dh: v.keys.p256dh, auth: v.keys.auth } };
}
