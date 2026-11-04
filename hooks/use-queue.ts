"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { QueueCommand, QueueSnapshot } from "@/lib/queue-contract";

type Auth = { configured: boolean; user: { id: string; email: string; isAdmin: boolean } | null };
type Push = { configured: boolean; publicKey: string | null; subscribed: boolean };
type QueueResponse = QueueSnapshot & { enabled: boolean };
type CommandInput = QueueCommand extends infer C ? C extends QueueCommand ? Omit<C, "requestId"> : never : never;

class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(12_000), ...init });
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) throw new ApiError(typeof body?.error === "string" ? body.error : typeof body?.message === "string" ? body.message : "요청을 처리하지 못했어요. 다시 확인해 주세요.", response.status);
  return body as T;
}
function browserPush() {
  const available = window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const installed = window.matchMedia("(display-mode: standalone)").matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
  return { available, permission: available ? Notification.permission : "default", iosNeedsInstall: ios && !installed };
}
async function currentSubscription() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
  const registration = await navigator.serviceWorker.getRegistration("/");
  return registration?.pushManager.getSubscription() ?? null;
}

export function useQueue() {
  const [auth, setAuth] = useState<Auth | null>(null);
  const [snapshot, setSnapshot] = useState<QueueResponse | null>(null);
  const [push, setPush] = useState<Push | null>(null);
  const [capability, setCapability] = useState({ available: false, permission: "default", iosNeedsInstall: false });
  const [now, setNow] = useState(0);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const offset = useRef(0);
  const mounted = useRef(false);
  const mutating = useRef(false);
  const fetching = useRef(false);
  const readEpoch = useRef(0);
  const identity = useRef<string | null>(null);
  const unresolvedCommand = useRef<{ key: string; requestId: string } | null>(null);

  const refresh = useCallback(async () => {
    if (fetching.current) return;
    fetching.current = true;
    const epoch = ++readEpoch.current;
    setRefreshing(true);
    try {
      const [nextAuth, nextSnapshot, subscription] = await Promise.all([
        json<Auth>("/api/auth/me"), json<QueueResponse | { enabled: false }>("/api/queue"), currentSubscription(),
      ]);
      const endpoint = subscription ? `?endpoint=${encodeURIComponent(subscription.endpoint)}` : "";
      const nextPush = nextAuth.user ? await json<Push>(`/api/push${endpoint}`) : null;
      if (!mounted.current || epoch !== readEpoch.current) return;
      if (identity.current !== nextAuth.user?.id) setMessage("");
      identity.current = nextAuth.user?.id ?? null;
      const normalized: QueueResponse = nextSnapshot.enabled ? nextSnapshot : { enabled: false, serverTime: Date.now(), paused: false, machines: [], tickets: [], runs: [], reports: [], counts: { washer: 0, dryer: 0 } };
      setAuth(nextAuth); setSnapshot(normalized);
      setPush(nextPush ? { ...nextPush, subscribed: Boolean(subscription && nextPush.subscribed) } : null);
      setCapability(browserPush());
      offset.current = normalized.serverTime - Date.now();
      setNow(normalized.serverTime); setOffline(false); setLoadError("");
    } catch (cause) {
      if (mounted.current && epoch === readEpoch.current) { setOffline(true); setLoadError(cause instanceof Error ? cause.message : "대기 현황을 불러오지 못했어요."); }
    } finally { fetching.current = false; if (mounted.current) setRefreshing(false); }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const initial = window.setTimeout(() => { setCapability(browserPush()); void refresh(); }, 0);
    const poll = window.setInterval(() => { if (!document.hidden && !mutating.current) void refresh(); }, 10_000);
    const tick = window.setInterval(() => setNow(Date.now() + offset.current), 1_000);
    const visible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", visible); window.addEventListener("online", visible);
    return () => { mounted.current = false; clearTimeout(initial); clearInterval(poll); clearInterval(tick); document.removeEventListener("visibilitychange", visible); window.removeEventListener("online", visible); };
  }, [refresh]);

  async function mutate(work: () => Promise<void>, success: string) {
    if (mutating.current) return false;
    mutating.current = true; readEpoch.current += 1; setBusy(true); setError(""); setMessage("");
    let ok = false;
    try { await work(); ok = true; if (mounted.current) setMessage(success); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "요청 결과를 확인할 수 없어요. 현황을 확인한 뒤 다시 시도해 주세요."); }
    finally { mutating.current = false; if (mounted.current) setBusy(false); }
    await refresh();
    return ok;
  }

  async function command(input: CommandInput, success = "변경 사항을 저장했어요.") {
    if (mutating.current) return false;
    const key = JSON.stringify(input);
    const requestId = unresolvedCommand.current?.key === key ? unresolvedCommand.current.requestId : crypto.randomUUID();
    unresolvedCommand.current = { key, requestId };
    return mutate(async () => {
      try {
        const result = await json<QueueResponse>("/api/queue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, requestId }) });
        if (mounted.current) { setSnapshot(result); offset.current = result.serverTime - Date.now(); setNow(result.serverTime); }
        unresolvedCommand.current = null;
      } catch (cause) { if (cause instanceof ApiError && cause.status < 500) unresolvedCommand.current = null; throw cause; }
    }, success);
  }

  async function enablePush() {
    const support = browserPush(); setCapability(support);
    if (support.iosNeedsInstall) { setError("아이폰과 아이패드는 Safari에서 공유 버튼을 누르고 홈 화면에 추가한 뒤, 추가한 앱에서 알림을 켜 주세요."); return; }
    if (!support.available) { setError("이 브라우저는 기기 알림을 지원하지 않아요. 알림을 지원하는 브라우저로 열어 주세요."); return; }
    if (!push?.configured || !push.publicKey) { setError("알림 서비스를 준비하고 있어요. 운영진에게 확인해 주세요."); return; }
    // Request permission synchronously from the click so browsers retain user activation.
    const permissionRequest = Notification.requestPermission();
    await mutate(async () => {
      const permission = await permissionRequest;
      setCapability(browserPush());
      if (permission !== "granted") throw new Error("알림을 허용해야 대기에 참여할 수 있어요. 브라우저의 사이트 설정에서 알림을 허용해 주세요.");
      const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      const key = push.publicKey!.replace(/-/g, "+").replace(/_/g, "/");
      const bytes = Uint8Array.from(atob(key.padEnd(Math.ceil(key.length / 4) * 4, "=")), (character) => character.charCodeAt(0));
      const subscription = await registration.pushManager.getSubscription() ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
      await json("/api/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subscription: subscription.toJSON() }) });
    }, "이 기기의 알림을 켰어요. 수거할 때와 배정받았을 때 알려 드려요.");
  }

  async function testPush() {
    return mutate(async () => {
      const subscription = await currentSubscription();
      if (!subscription) throw new Error("이 기기의 알림을 먼저 켜 주세요.");
      await json("/api/push/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: subscription.endpoint }) });
    }, "시험 알림을 요청했어요. 이 기기에 알림이 도착하는지 확인해 주세요.");
  }

  async function logout() {
    await mutate(async () => {
      const subscription = await currentSubscription();
      if (subscription) {
        await json("/api/push", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: subscription.endpoint }) });
        await subscription.unsubscribe();
      }
      await json("/api/auth/logout", { method: "POST" });
      unresolvedCommand.current = null;
      setAuth((value) => value ? { ...value, user: null } : value); setSnapshot(null); }, "로그아웃했어요.");
  }

  const pushReady = Boolean(push?.configured && push.subscribed && capability.available && capability.permission === "granted");
  return { auth, snapshot, push, capability, pushReady, now, offline, error: error || loadError, message, busy, refreshing, refresh, command, enablePush, testPush, logout, setError };
}

export type QueueController = ReturnType<typeof useQueue>;
