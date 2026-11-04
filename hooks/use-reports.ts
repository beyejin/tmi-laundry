"use client";

import { useCallback, useRef, useState } from "react";
import { REPORT_WINDOW_MS } from "@/lib/events";
import type { Machine } from "@/hooks/use-laundry";

const STORAGE_KEY = "tmi-laundry:reports";

function readReports(): Record<string, number> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function writeReports(value: Record<string, number>) {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch { /* 저장이 막혀도 신고는 계속 돼요 */ }
}

/** 고장 신고: 확인 대화상자 없이 바로 보내요. 같은 기기는 이 브라우저에서 10분간 버튼을 막아요(편의용이고, 실제 한도는 서버가 지켜요). */
export function useReports({ online, currentTime, setMessage }: { online: boolean; currentTime: number; setMessage: (message: string) => void }) {
  const [reports, setReports] = useState<Record<string, number>>({});
  const [pending, setPending] = useState<string | null>(null);
  const busy = useRef(false);
  const loadedStorage = useRef(false);
  // 저장소는 처음 렌더 뒤에만 읽어요(서버 렌더와 어긋나지 않게).
  if (typeof window !== "undefined" && !loadedStorage.current && currentTime > 0) { loadedStorage.current = true; setReports(readReports()); }

  const recentlyReported = useCallback((machineId: string) => {
    const at = reports[machineId];
    return typeof at === "number" && currentTime - at < REPORT_WINDOW_MS && currentTime >= at;
  }, [reports, currentTime]);

  const report = useCallback(async (machine: Machine) => {
    if (busy.current || !online) return;
    busy.current = true;
    setPending(machine.id);
    try {
      const response = await fetch(`/api/machines/${machine.id}/report`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = await response.json().catch(() => ({})) as { error?: string };
      if (response.ok || response.status === 429) {
        const next = { ...readReports(), [machine.id]: currentTime };
        writeReports(next);
        setReports(next);
        setMessage(response.ok ? "고장 신고를 접수했어요." : data.error ?? "이미 신고가 접수됐어요. 관리자가 확인할 거예요.");
      } else setMessage(data.error ?? "신고를 접수하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } catch { setMessage("연결을 확인하지 못했어요. 잠시 후 다시 시도해 주세요."); }
    finally { busy.current = false; setPending(null); }
  }, [online, currentTime, setMessage]);

  return { pending, recentlyReported, report };
}
