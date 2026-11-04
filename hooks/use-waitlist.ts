"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Snapshot } from "@/hooks/use-laundry";
import type { WaitlistEntry } from "@/lib/waitlist";

const STORAGE_KEY = "tmi-laundry:waitlist";
type Mine = Record<string, string>;
type Options = { waitlist: WaitlistEntry[]; loaded: boolean; online: boolean; setMessage: (message: string) => void; applySnapshot: (data: Snapshot) => void; refresh: (force?: boolean) => Promise<void> };
type Response = Snapshot & { error?: string; joined?: { id: string; token: string } };

function readMine(): Mine {
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, token]) => typeof token === "string")) as Mine;
  } catch { return {}; }
}

function writeMine(mine: Mine) {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(mine)); } catch { /* 저장소를 쓸 수 없어도 화면은 동작해요. */ }
}

export function useWaitlist({ waitlist, loaded, online, setMessage, applySnapshot, refresh }: Options) {
  const [mine, setMine] = useState<Mine>({});
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);

  useEffect(() => {
    const read = window.setTimeout(() => { setMine(readMine()); setReady(true); }, 0);
    return () => window.clearTimeout(read);
  }, []);

  useEffect(() => {
    if (!ready || !loaded) return;
    const ids = new Set(waitlist.map((entry) => entry.id));
    setMine((current) => {
      const kept = Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id)));
      if (Object.keys(kept).length === Object.keys(current).length) return current;
      writeMine(kept);
      return kept;
    });
  }, [waitlist, loaded, ready]);

  const send = useCallback(async (body: object): Promise<{ ok: boolean; status: number; data: Response | null }> => {
    try {
      const response = await fetch("/api/waitlist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(12_000) });
      const data = await response.json().catch(() => null) as Response | null;
      return { ok: response.ok, status: response.status, data };
    } catch { return { ok: false, status: 0, data: null }; }
  }, []);

  const join = useCallback(async (locationId: string, nickname: string) => {
    if (busy.current || !online) return false;
    busy.current = true;
    setPending(true);
    try {
      const { ok, status, data } = await send({ action: "join", locationId, nickname });
      if (ok && data?.joined) {
        const next = { ...readMine(), [data.joined.id]: data.joined.token };
        writeMine(next);
        setMine(next);
        applySnapshot(data);
        const ahead = Math.max(0, (data.waitlist ?? []).filter((entry) => entry.locationId === locationId).findIndex((entry) => entry.id === data.joined!.id));
        setMessage(`대기 명단에 올렸어요. 앞에 ${ahead}명이 있어요.`);
        return true;
      }
      setMessage(status === 409 ? data?.error ?? "대기 인원이 가득 찼거나 같은 이름이 이미 있어요." : status === 0 ? "연결을 확인하지 못했어요. 잠시 후 다시 시도해 주세요." : data?.error ?? "대기 명단에 올리지 못했어요. 잠시 후 다시 시도해 주세요.");
      await refresh(true);
      return false;
    } finally { busy.current = false; setPending(false); }
  }, [online, send, applySnapshot, setMessage, refresh]);

  const leave = useCallback(async (entryId: string, message = "대기 명단에서 빠졌어요.") => {
    const token = readMine()[entryId];
    if (busy.current || !token) return false;
    busy.current = true;
    setPending(true);
    try {
      const { ok, status, data } = await send({ action: "leave", id: entryId, token });
      if (ok && data) {
        const { [entryId]: _removed, ...rest } = readMine();
        writeMine(rest);
        setMine(rest);
        applySnapshot(data);
        setMessage(message);
        return true;
      }
      if (status === 404) {
        const { [entryId]: _removed, ...rest } = readMine();
        writeMine(rest);
        setMine(rest);
      }
      setMessage(status === 404 ? "이미 빠졌거나 내 대기 기록이 아니에요." : status === 0 ? "연결을 확인하지 못했어요. 잠시 후 다시 시도해 주세요." : data?.error ?? "대기 명단에서 빼지 못했어요. 잠시 후 다시 시도해 주세요.");
      await refresh(true);
      return false;
    } finally { busy.current = false; setPending(false); }
  }, [send, applySnapshot, setMessage, refresh]);

  /** 맨 앞 대기자 건너뛰기. 누구나 할 수 있어서 토큰 없이 보내요. 규칙은 서버가 같은 canSkip으로 다시 판정해요. */
  const skip = useCallback(async (entryId: string, position = 1) => {
    if (busy.current || !online) return false;
    busy.current = true;
    setPending(true);
    try {
      const { ok, status, data } = await send({ action: "skip", id: entryId });
      if (ok && data) {
        applySnapshot(data);
        setMessage(`${position}번 대기자를 건너뛰었어요.`);
        return true;
      }
      setMessage(status === 0 ? "연결을 확인하지 못했어요. 잠시 후 다시 시도해 주세요." : data?.error ?? "건너뛰지 못했어요. 잠시 후 다시 시도해 주세요.");
      await refresh(true);
      return false;
    } finally { busy.current = false; setPending(false); }
  }, [online, send, applySnapshot, setMessage, refresh]);

  return { mine, join, leave, skip, pending };
}
