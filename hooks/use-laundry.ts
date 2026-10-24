"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MACHINES, type Command } from "@/lib/laundry";

export type Machine = (typeof MACHINES)[number] & {
  endsAt: number | null;
  updatedAt: number | null;
  version: number;
};
type Snapshot = { serverTime: number; machines: Machine[] };
type UpdateResult = { status: "saved" | "conflict" | "failed"; error?: string };

const emptyMachines: Machine[] = MACHINES.map((machine) => ({ ...machine, endsAt: null, updatedAt: null, version: 0 }));

export function useLaundry() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connection, setConnection] = useState<"loading" | "online" | "offline">("loading");
  const [now, setNow] = useState(0);
  const [offset, setOffset] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const requestId = useRef(0);
  const reading = useRef<AbortController | null>(null);
  const writing = useRef<AbortController | null>(null);
  const mutating = useRef(false);
  const mounted = useRef(false);

  const applySnapshot = useCallback((data: Snapshot) => {
    setSnapshot(data);
    setOffset(data.serverTime - Date.now());
    setNow(Date.now());
    setConnection("online");
  }, []);

  const refresh = useCallback(async (force = false) => {
    if (!mounted.current || (mutating.current && !force)) return;
    reading.current?.abort();
    const controller = new AbortController();
    reading.current = controller;
    const id = ++requestId.current;
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 8_000);
    setRefreshing(true);
    try {
      const response = await fetch("/api/machines", { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("현황을 불러오지 못했어요.");
      const data = await response.json() as Snapshot;
      if (mounted.current && id === requestId.current) applySnapshot(data);
    } catch {
      if (mounted.current && (timedOut || !controller.signal.aborted) && id === requestId.current) setConnection("offline");
    } finally {
      window.clearTimeout(timeout);
      if (mounted.current && id === requestId.current) setRefreshing(false);
    }
  }, [applySnapshot]);

  useEffect(() => {
    mounted.current = true;
    const initialRead = window.setTimeout(() => void refresh(), 0);
    const poll = window.setInterval(() => void refresh(), 10_000);
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      mounted.current = false;
      requestId.current += 1;
      window.clearTimeout(initialRead);
      window.clearInterval(poll);
      window.clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
      reading.current?.abort();
      writing.current?.abort();
    };
  }, [refresh]);

  async function updateMachine(machine: Machine, action: Command["action"], minutes?: number): Promise<UpdateResult> {
    if (mutating.current || connection !== "online" || !mounted.current) return { status: "failed", error: "연결과 최신 현황을 확인한 뒤 다시 시도해 주세요." };
    mutating.current = true;
    reading.current?.abort();
    const id = ++requestId.current;
    const controller = new AbortController();
    writing.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 12_000);
    setRefreshing(false);
    setPending(machine.id);
    setMessage("");
    let requestError = "";
    try {
      const response = await fetch(`/api/machines/${machine.id}`, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, minutes, expectedVersion: machine.version }),
      });
      const data = await response.json() as Snapshot & { error?: string };
      if (!mounted.current) return { status: "failed" };
      if (!response.ok) {
        if (response.status === 409) {
          const error = "다른 분이 정보를 변경했어요. 최신 현황을 확인한 뒤 다시 시도해 주세요.";
          setMessage(error);
          await refresh(true);
          return { status: "conflict", error };
        }
        requestError = data.error || "등록하지 못했어요. 잠시 후 다시 시도해 주세요.";
        throw new Error(requestError);
      }
      if (id === requestId.current) applySnapshot(data);
      setMessage(action === "clear" ? `${machine.name}의 등록을 취소했어요.` : action === "start" ? `${machine.name} ${machine.defaultMinutes}분을 등록했어요.` : `${machine.name}의 남은 시간을 ${minutes}분으로 수정했어요.`);
      return { status: "saved" };
    } catch {
      if (!mounted.current) return { status: "failed" };
      const error = requestError || "등록 결과를 확인하지 못했어요. 최신 현황을 다시 확인해 주세요.";
      setMessage(error);
      await refresh(true);
      return { status: "failed", error };
    } finally {
      window.clearTimeout(timeout);
      mutating.current = false;
      if (mounted.current) setPending(null);
    }
  }

  return {
    machines: snapshot?.machines ?? emptyMachines,
    loaded: snapshot !== null,
    currentTime: now + offset,
    lastSync: snapshot?.serverTime ?? null,
    connection,
    refreshing,
    pending,
    message,
    setMessage,
    refresh,
    updateMachine,
    actionsDisabled: connection !== "online" || pending !== null || snapshot === null,
  };
}
