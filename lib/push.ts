import webPush from "web-push";
import { allowedPushEndpoint, type PushSubscriptionValue } from "./push-validation.ts";
import { claimNotifications, settleNotifications, tickQueues } from "./queue-store.ts";
import { queueEnabled } from "./queue-config.ts";

export interface PushEnv { VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; APP_ORIGIN?: string; QUEUE_ENABLED?: string }
type PushRow = { endpoint: string; p256dh: string; auth: string };
export function pushConfigured(env: PushEnv) {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.APP_ORIGIN);
}
export async function hasPushSubscription(db: D1Database, userId: string, endpoint?: string) {
  const row = endpoint
    ? await db.prepare("SELECT 1 FROM push_subscriptions WHERE user_id = ? AND endpoint = ? AND active = 1").bind(userId, endpoint).first()
    : await db.prepare("SELECT 1 FROM push_subscriptions WHERE user_id = ? AND active = 1 LIMIT 1").bind(userId).first();
  return Boolean(row);
}
export async function savePushSubscription(db: D1Database, userId: string, subscription: PushSubscriptionValue, now = Date.now()) {
  // The count and ownership checks share the INSERT statement, including concurrent requests.
  return db.prepare(`INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, active, updated_at)
    SELECT ?1, ?2, ?3, ?4, 1, ?5
    WHERE (SELECT COUNT(*) FROM push_subscriptions WHERE user_id = ?2 AND active = 1) < 5
       OR EXISTS (SELECT 1 FROM push_subscriptions WHERE endpoint = ?1 AND user_id = ?2 AND active = 1)
    ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth,
      active = 1, updated_at = excluded.updated_at
    WHERE push_subscriptions.user_id = excluded.user_id
    RETURNING endpoint`).bind(subscription.endpoint, userId, subscription.keys.p256dh, subscription.keys.auth, now).first();
}
export async function sendPush(subscription: PushSubscriptionValue, payload: {title: string; body: string; url: string; tag: string}, env: PushEnv, ttl = 300, transport: typeof fetch = fetch) {
  if (!pushConfigured(env) || !allowedPushEndpoint(subscription.endpoint)) return { accepted: false, expired: false };
  try {
    const request = webPush.generateRequestDetails(subscription, JSON.stringify(payload), {
      vapidDetails: { subject: env.APP_ORIGIN!, publicKey: env.VAPID_PUBLIC_KEY!, privateKey: env.VAPID_PRIVATE_KEY! },
      TTL: Math.max(1, Math.min(3600, Math.floor(ttl))), urgency: "high", contentEncoding: "aes128gcm",
    });
    const response = await transport(request.endpoint, { method: request.method, headers: request.headers as HeadersInit,
      body: request.body as BodyInit | null, redirect: "error", signal: AbortSignal.timeout(8000) });
    await response.body?.cancel();
    return { accepted: response.status === 201 || response.status === 202, expired: response.status === 404 || response.status === 410 };
  } catch { return { accepted: false, expired: false }; }
}
async function sendToUser(db: D1Database, userId: string, payload: {title: string; body: string; url: string; tag: string}, env: PushEnv, ttl: number) {
  const { results } = await db.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ? AND active = 1 LIMIT 5").bind(userId).all<PushRow>();
  const attempts = await Promise.all(results.map(async (row) => {
    const result = await sendPush({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, payload, env, ttl);
    if (result.expired) await db.prepare("UPDATE push_subscriptions SET active = 0 WHERE endpoint = ? AND user_id = ? AND p256dh = ? AND auth = ?").bind(row.endpoint, userId, row.p256dh, row.auth).run();
    return result.accepted;
  }));
  return attempts.some(Boolean);
}
export async function processPushOutbox(db: D1Database, env: PushEnv) {
  if (!queueEnabled(env)) return;
  await tickQueues(db);
  // Do not consume retries while deployment credentials are missing.
  if (!pushConfigured(env)) return;
  const jobs = await claimNotifications(db, Date.now(), 8);
  const results = await Promise.all(jobs.map(async (job) => {
    const remaining = job.expiresAt == null ? 3600 : Math.floor((job.expiresAt - Date.now()) / 1000);
    const success = remaining > 0 && await sendToUser(db, job.userId, { title: job.title, body: job.body, url: job.url, tag: job.tag }, env, remaining);
    return { id: job.id, leaseToken: job.leaseToken, success };
  }));
  if (results.length) await settleNotifications(db, results);
}
export async function sendPushTest(db: D1Database, userId: string, endpoint: string, env: PushEnv, now = Date.now()) {
  const row = await db.prepare(`UPDATE push_subscriptions SET last_test_at = ?
    WHERE user_id = ? AND endpoint = ? AND active = 1 AND last_test_at < ? RETURNING endpoint, p256dh, auth`)
    .bind(now, userId, endpoint, now - 30_000).first<PushRow>();
  if (!row) return null;
  const result = await sendPush({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
    { title: "TMI 세탁실", body: "알림 설정 확인용 메시지예요. 화면을 닫은 상태에서도 확인해 주세요.", url: "/?queue=1", tag: "tmi-push-test" }, env);
  if (result.expired) await db.prepare("UPDATE push_subscriptions SET active = 0 WHERE user_id = ? AND endpoint = ? AND p256dh = ? AND auth = ?").bind(userId, row.endpoint, row.p256dh, row.auth).run();
  return result.accepted;
}
