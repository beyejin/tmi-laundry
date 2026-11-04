"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LOCATIONS, formatSinceEnd, machineStatus, type MachineStatus } from "@/lib/laundry";
import type { Machine } from "@/hooks/use-laundry";
import type { PeriodStats } from "@/lib/admin";
import type { WaitlistEntry } from "@/lib/waitlist";

const TOKEN_KEY = "tmi-laundry:admin";
const STATUS_NAMES: Record<MachineStatus, string> = { unknown: "미확인", running: "사용 중", finished: "예상 종료", stale: "확인 필요", service: "점검 중" };
const KIND_LABELS: [string, string][] = [["start", "시작"], ["adjust", "시간 수정"], ["clear", "등록 취소"], ["waitlist_join", "대기 등록"], ["waitlist_leave", "대기 취소"], ["waitlist_turn", "차례 정리"], ["waitlist_skip", "건너뛰기"], ["report", "고장 신고"], ["service_on", "점검 시작"], ["service_off", "점검 해제"], ["admin_reset", "관리자 초기화"], ["admin_remove", "관리자 대기 삭제"]];

type AdminMachine = Machine & { reports24h: number };
type Stats = {
  stats: { today: PeriodStats; week: PeriodStats; all: PeriodStats; hourly7d: number[] };
  accuracy: { count: number; medianSec: number | null; meanAbsSec: number | null };
  at: number;
};
type Overview = { serverTime: number; machines: AdminMachine[]; waitlist: WaitlistEntry[] };
type OverviewResponse = Overview & Partial<Pick<Stats, "stats" | "accuracy">>;

function timeLabel(time: number) {
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false }).format(time);
}

function kstDate(time: number) {
  return new Date(time + 9 * 3_600_000).toISOString().slice(0, 10);
}

function minutesText(seconds: number | null) {
  return seconds === null ? "-" : `${(seconds / 60).toFixed(1)}분`;
}

function readToken() {
  try { return window.sessionStorage.getItem(TOKEN_KEY) ?? ""; } catch { return ""; }
}

export default function AdminPage() {
  const [token, setToken] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [full, setFull] = useState<Stats | null>(null);
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const armTimer = useRef<number | null>(null);
  const busyRef = useRef(false);
  const dirtyRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setToken(readToken());
      const today = kstDate(Date.now());
      setTo(today);
      setFrom(kstDate(Date.now() - 29 * 86_400_000));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const logout = useCallback((message = "") => {
    dirtyRef.current.clear();
    try { window.sessionStorage.removeItem(TOKEN_KEY); } catch { /* 저장소가 막혀도 로그아웃은 돼요 */ }
    setToken("");
    setOverview(null);
    setFull(null);
    setError(message);
  }, []);

  const call = useCallback(async (path: string, init?: RequestInit) => {
    const response = await fetch(path, { cache: "no-store", ...init, headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), Authorization: `Bearer ${token}` } });
    if (response.status === 401) { logout("관리자 인증이 필요해요. 토큰을 다시 입력해 주세요."); throw new Error("unauthorized"); }
    return response;
  }, [token, logout]);

  const apply = useCallback((data: OverviewResponse) => {
    setOverview({ serverTime: data.serverTime, machines: data.machines, waitlist: data.waitlist });
    if (data.stats && data.accuracy) setFull({ stats: data.stats, accuracy: data.accuracy, at: data.serverTime });
    setOffset(data.serverTime - Date.now());
    setNow(Date.now());
    // 입력 중(dirty)이 아닌 기기의 메모 칸은 서버 값(점검 중이 아니면 빈 칸)으로 맞춰요.
    setNotes((current) => {
      const next = { ...current };
      for (const machine of data.machines) if (!dirtyRef.current.has(machine.id)) next[machine.id] = machine.outOfService ? machine.serviceNote ?? "" : "";
      return next;
    });
  }, []);

  /** 통계를 포함한 전체 현황은 처음과 "통계 새로고침"에서만, 30초 폴링은 가벼운 응답(stats=0)만 받아요. */
  const refresh = useCallback(async (withStats = false) => {
    if (!token || busyRef.current) return;
    try {
      const response = await call(`/api/admin/overview?stats=${withStats ? 1 : 0}`);
      if (!response.ok) { setError("현황을 불러오지 못했어요. 잠시 후 다시 시도해 주세요."); return; }
      setError("");
      apply(await response.json() as OverviewResponse);
    } catch (caught) {
      if ((caught as Error).message !== "unauthorized") setError("연결을 확인하지 못했어요.");
    }
  }, [token, call, apply]);

  useEffect(() => {
    if (!token) return;
    const first = window.setTimeout(() => void refresh(true), 0);
    const poll = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(false); }, 30_000);
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(false); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.clearTimeout(first); window.clearInterval(poll); window.clearInterval(tick); document.removeEventListener("visibilitychange", onVisible); };
  }, [token, refresh]);

  async function login(event: React.FormEvent) {
    event.preventDefault();
    const value = input.trim();
    if (!value) return;
    try { window.sessionStorage.setItem(TOKEN_KEY, value); } catch { /* 저장이 안 돼도 이 탭에서는 계속 써요 */ }
    setInput("");
    setError("");
    setToken(value);
  }

  async function act(key: string, path: string, body: unknown, success: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(key);
    setNotice("");
    try {
      const response = await call(path, { method: "POST", body: JSON.stringify(body) });
      const data = await response.json().catch(() => ({})) as OverviewResponse & { error?: string };
      if (!response.ok) { setError(data.error ?? "처리하지 못했어요."); return; }
      setError("");
      if (key.startsWith("service:")) dirtyRef.current.delete(key.slice("service:".length));
      apply(data);
      setNotice(success);
    } catch (caught) {
      if ((caught as Error).message !== "unauthorized") setError("연결을 확인하지 못했어요.");
    } finally { busyRef.current = false; setBusy(null); }
  }

  /** 위험 동작은 확인 창 없이 같은 버튼을 한 번 더 눌러야 실행돼요. 4초 안에 누르지 않으면 원래대로 돌아가요. */
  function twoStep(key: string, run: () => void) {
    if (armed === key) {
      if (armTimer.current) window.clearTimeout(armTimer.current);
      setArmed(null);
      run();
      return;
    }
    setArmed(key);
    if (armTimer.current) window.clearTimeout(armTimer.current);
    armTimer.current = window.setTimeout(() => setArmed(null), 4_000);
  }

  async function download() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy("csv");
    setNotice("");
    try {
      const response = await call(`/api/admin/events.csv?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      if (!response.ok) { setError(((await response.json().catch(() => ({}))) as { error?: string }).error ?? "내려받지 못했어요."); return; }
      const truncated = response.headers.get("X-Truncated") === "1";
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `tmi-laundry-events-${from}_${to}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setError("");
      setNotice(truncated ? "최대 50,000행까지만 내려받았어요. 기간을 나눠 다시 받아 주세요." : "CSV를 내려받았어요.");
    } catch (caught) {
      if ((caught as Error).message !== "unauthorized") setError("연결을 확인하지 못했어요.");
    } finally { busyRef.current = false; setBusy(null); }
  }

  if (token === null) return <main className="admin-shell"><p className="admin-note">불러오는 중이에요.</p></main>;

  if (!token) return <main className="admin-shell">
    <h1>관리자</h1>
    <form className="admin-card" onSubmit={(event) => void login(event)} style={{ marginTop: "var(--spacing-4)" }}>
      <div className="admin-field"><label htmlFor="admin-token">관리자 토큰</label><input id="admin-token" type="password" autoComplete="off" value={input} onChange={(event) => setInput(event.target.value)} /></div>
      <div className="admin-row" style={{ marginTop: "var(--spacing-3)" }}><button type="submit" className="admin-btn is-primary" disabled={!input.trim()}>들어가기</button></div>
      {error && <p className="admin-error" role="alert">{error}</p>}
      <p className="admin-note" style={{ marginTop: "var(--spacing-3)" }}>토큰은 이 탭에만 저장되고, 탭을 닫으면 사라져요.</p>
    </form>
  </main>;

  const current = now + offset;
  return <main className="admin-shell">
    <div className="admin-top"><h1>세탁실 관리자</h1><div className="admin-row"><a className="admin-btn" href="/" style={{ display: "inline-flex", alignItems: "center" }}>현황 보기</a><button type="button" className="admin-btn" onClick={() => logout()}>로그아웃</button></div></div>
    <div aria-live="polite">{error && <p className="admin-error" role="alert">{error}</p>}{notice && <p className="admin-note">{notice}</p>}</div>

    <section className="admin-card" aria-labelledby="admin-machines">
      <h2 id="admin-machines">기기</h2>
      {!overview ? <p className="admin-note">불러오는 중이에요.</p> : LOCATIONS.map((location) => <div className="admin-floor" key={location.id}>
        <h3>{location.label}</h3>
        {overview.machines.filter((machine) => machine.locationId === location.id).map((machine) => {
          const status = machineStatus(machine.endsAt, current, machine.outOfService);
          const seconds = machine.endsAt === null ? null : Math.max(0, Math.ceil((machine.endsAt - current) / 1_000));
          const note = notes[machine.id] ?? "";
          const resetKey = `reset:${machine.id}`;
          return <div key={machine.id} className={`admin-machine status-${status}`}>
            <div className="admin-machine-head"><strong>{machine.name}</strong><span className="admin-badge">{STATUS_NAMES[status]}</span></div>
            <span className="admin-meta">{status === "running" ? `${Math.ceil(seconds! / 60)}분 남음 (${timeLabel(machine.endsAt!)} 종료 예상)` : status === "finished" || status === "stale" ? `끝난 지 ${formatSinceEnd(machine.endsAt!, current)}` : status === "service" ? `메모: ${machine.serviceNote ?? "없음"}` : "등록 없음"}</span>
            <span className={`admin-meta ${machine.reports24h ? "has-report" : ""}`}>최근 24시간 고장 신고 {machine.reports24h}건</span>
            <div className="admin-field"><label htmlFor={`note-${machine.id}`}>점검 메모 (40자까지)</label><input id={`note-${machine.id}`} maxLength={40} value={note} onChange={(event) => { dirtyRef.current.add(machine.id); setNotes((currentNotes) => ({ ...currentNotes, [machine.id]: event.target.value })); }} placeholder="예: 배수 불량, 내일 수리" /></div>
            <div className="admin-row">
              <button type="button" className={`admin-btn ${machine.outOfService ? "" : "is-danger"}`} disabled={busy !== null} onClick={() => void act(`service:${machine.id}`, `/api/admin/machines/${machine.id}`, { action: "service", on: !machine.outOfService, note }, machine.outOfService ? `${machine.name} 점검을 풀었어요.` : `${machine.name}을 점검 중으로 바꿨어요.`)}>{machine.outOfService ? "점검 해제" : "점검 시작"}</button>
              {machine.outOfService && <button type="button" className="admin-btn" disabled={busy !== null} onClick={() => void act(`service:${machine.id}`, `/api/admin/machines/${machine.id}`, { action: "service", on: true, note }, "점검 메모를 저장했어요.")}>메모 저장</button>}
              <button type="button" className={`admin-btn ${armed === resetKey ? "is-armed" : "is-danger"}`} disabled={busy !== null || machine.endsAt === null} onClick={() => twoStep(resetKey, () => void act(resetKey, `/api/admin/machines/${machine.id}`, { action: "reset" }, `${machine.name} 등록을 초기화했어요.`))}>{armed === resetKey ? "한 번 더 누르면 초기화해요" : "등록 초기화"}</button>
            </div>
          </div>;
        })}
      </div>)}
    </section>

    <section className="admin-card" aria-labelledby="admin-waitlist">
      <h2 id="admin-waitlist">대기 명단</h2>
      {!overview ? null : LOCATIONS.map((location) => {
        const entries = overview.waitlist.filter((entry) => entry.locationId === location.id);
        return <div className="admin-floor" key={location.id}>
          <h3>{location.label} · {entries.length}명</h3>
          {entries.length ? <ol className="admin-waitlist">{entries.map((entry, index) => {
            const key = `remove:${entry.id}`;
            return <li key={entry.id}><span>{index + 1}. {entry.nickname} · {timeLabel(entry.createdAt)} 등록</span><button type="button" className={`admin-btn ${armed === key ? "is-armed" : "is-danger"}`} disabled={busy !== null} onClick={() => twoStep(key, () => void act(key, "/api/admin/waitlist", { action: "remove", id: entry.id }, `${entry.nickname}님을 명단에서 뺐어요.`))}>{armed === key ? "한 번 더 누르면 삭제해요" : "삭제"}</button></li>;
          })}</ol> : <p className="admin-note">대기하는 사람이 없어요.</p>}
        </div>;
      })}
    </section>

    <section className="admin-card" aria-labelledby="admin-stats">
      <div className="admin-top"><h2 id="admin-stats">통계</h2><div className="admin-row">{full && <span className="admin-note">통계 기준 {timeLabel(full.at)}</span>}<button type="button" className="admin-btn" disabled={busy !== null} onClick={() => void refresh(true)}>통계 새로고침</button></div></div>
      {!full ? <p className="admin-note">불러오는 중이에요.</p> : <>
        <div className="admin-scroll"><table className="admin-table"><thead><tr><th scope="col">종류</th><th scope="col">오늘</th><th scope="col">7일</th><th scope="col">전체</th></tr></thead><tbody>
          {KIND_LABELS.map(([kind, label]) => <tr key={kind}><th scope="row">{label}</th>{(["today", "week", "all"] as const).map((period) => <td key={period}>{full.stats[period].counts[kind] ?? 0}</td>)}</tr>)}
          <tr><th scope="row">세탁기 시작</th>{(["today", "week", "all"] as const).map((period) => <td key={period}>{full.stats[period].washerStarts}</td>)}</tr>
          <tr><th scope="row">건조기 시작</th>{(["today", "week", "all"] as const).map((period) => <td key={period}>{full.stats[period].dryerStarts}</td>)}</tr>
        </tbody></table></div>
        <p className="admin-note">오늘은 한국 시간 자정부터예요. 전체는 보관 기간(120일) 안의 기록이에요.</p>
        <h3 style={{ marginTop: "var(--spacing-4)" }}>최근 7일 시작 시간대</h3>
        <div className="admin-hours" role="list" aria-label="시간대별 시작 횟수">{full.stats.hourly7d.map((count, hour) => <div key={hour} style={{ display: "contents" }} role="listitem"><span>{String(hour).padStart(2, "0")}시</span><span className="bar" style={{ width: `${Math.max(count ? 2 : 0, (count / Math.max(1, ...full.stats.hourly7d)) * 100)}%` }} /><span>{count}</span></div>)}</div>
      </>}
    </section>

    <section className="admin-card" aria-labelledby="admin-accuracy">
      <h2 id="admin-accuracy">예상 정확도 (최근 30일)</h2>
      {!full ? null : full.accuracy.count === 0 ? <p className="admin-note">시간을 수정한 기록이 아직 없어요.</p> : <div className="admin-scroll"><table className="admin-table"><tbody>
        <tr><th scope="row">수정 건수</th><td>{full.accuracy.count}건</td></tr>
        <tr><th scope="row">중앙값 차이</th><td>{minutesText(full.accuracy.medianSec)}</td></tr>
        <tr><th scope="row">평균 절댓값 차이</th><td>{minutesText(full.accuracy.meanAbsSec)}</td></tr>
      </tbody></table></div>}
      <p className="admin-note">차이는 수정 직전 남은 시간에서 새로 입력한 남은 시간을 뺀 값이에요. 양수면 처음 등록한 시간이 실제보다 길었다는 뜻이에요.</p>
    </section>

    <section className="admin-card" aria-labelledby="admin-csv">
      <h2 id="admin-csv">이용 기록 내려받기</h2>
      <div className="admin-row">
        <div className="admin-field"><label htmlFor="csv-from">시작 날짜</label><input id="csv-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></div>
        <div className="admin-field"><label htmlFor="csv-to">끝 날짜</label><input id="csv-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} /></div>
        <button type="button" className="admin-btn is-primary" disabled={busy !== null || !from || !to} onClick={() => void download()}>CSV 내려받기</button>
      </div>
      <p className="admin-note" style={{ marginTop: "var(--spacing-2)" }}>한국 시간 기준이고 끝 날짜를 포함해요. 최대 180일, 별명과 토큰은 들어 있지 않아요.</p>
    </section>
  </main>;
}
