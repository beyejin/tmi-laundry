"use client";

import { useEffect, useState } from "react";
import { Bell, Check, QrCode, RefreshCw } from "lucide-react";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Grid } from "@astryxdesign/core/Grid";
import { Button } from "@astryxdesign/core/Button";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { findLocation, findMachine } from "@/lib/laundry";
import type { QueueController } from "@/hooks/use-queue";
import type { QueueMachineView, QueueReportView, QueueRunView, QueueTicketView, TicketState } from "@/lib/queue-contract";
import "./queue.css";

const activeStates: TicketState[] = ["preparing", "waiting", "called", "paused", "in_use", "pickup"];
const ticketLabels: Record<TicketState, string> = { preparing: "준비 전", waiting: "대기 중", called: "현장 확인 요청", paused: "알림 확인 필요", in_use: "사용 중", pickup: "수거 대기", completed: "이용 완료", cancelled: "취소", expired: "호출 만료" };
const reportLabels = { uncollected: "빨래가 남아 있음", still_running: "기기가 아직 작동 중", fault: "고장 확인" };
export const queueMachineLabels = { unknown: "현장 확인 필요", running: "사용 중", check: "수거 여부 확인", blocked: "현장 확인 대기", available: "빈 기기 확인됨", fault: "고장" };

function machineLabel(id: string) {
  const machine = findMachine(id);
  return machine ? `${findLocation(machine.locationId)?.floor}층 ${machine.name}` : "기기 확인 중";
}
function time(value: number) { return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(value); }
function remaining(until: number, now: number) {
  const seconds = Math.max(0, Math.ceil((until - now) / 1_000));
  return `${Math.floor(seconds / 60)}분 ${String(seconds % 60).padStart(2, "0")}초`;
}

export function QueuePanel({ queue, selectedMachineId, fromQr }: { queue: QueueController; selectedMachineId: string | null; fromQr: boolean }) {
  const { auth, snapshot, push, capability, pushReady, busy, offline } = queue;
  const [authError, setAuthError] = useState<string | null>(null);
  useEffect(() => { const timer = window.setTimeout(() => setAuthError(new URLSearchParams(window.location.search).get("authError")), 0); return () => clearTimeout(timer); }, []);
  const tickets = snapshot?.tickets.filter((ticket) => activeStates.includes(ticket.state)).sort((a, b) => a.sequence - b.sequence) ?? [];
  const runs = snapshot?.runs.filter((run) => run.status !== "completed").sort((a, b) => Number(b.status === "pickup" || b.endsAt <= queue.now) - Number(a.status === "pickup" || a.endsAt <= queue.now) || a.endsAt - b.endsAt) ?? [];
  const disabled = busy || offline;
  const returnUrl = typeof window === "undefined" ? null : new URL(window.location.href);
  returnUrl?.searchParams.delete("authError");
  const loginHref = returnUrl ? `/api/auth/login?returnTo=${encodeURIComponent(returnUrl.pathname + returnUrl.search)}` : "/api/auth/login";
  return <VStack as="section" gap={4} padding={5} className="queue-panel" id="my-queue" aria-labelledby="queue-title">
    <HStack gap={3} hAlign="between" vAlign="center" wrap="wrap">
      <VStack gap={1}><h2 id="queue-title">내 대기와 사용</h2><p className="queue-muted">3생활관 여자 2층부터 5층까지 함께 기다려요.</p></VStack>
      <Button variant="ghost" label="대기 새로고침" icon={<RefreshCw size={16} />} isLoading={queue.refreshing} isDisabled={busy} onClick={() => void queue.refresh()} />
    </HStack>
    {queue.error && <p className="queue-error" role="alert">{queue.error}</p>}
    {queue.message && <p className="queue-feedback" role="status">{queue.message}</p>}
    {authError && <p className="queue-error" role="alert">{authError === "school_account_required" ? "학교 Google 계정으로 로그인해 주세요." : "로그인을 완료하지 못했어요. 다시 로그인해 주세요."}</p>}
    {!snapshot && <p className="queue-muted">{offline ? "대기 현황을 다시 확인해 주세요. 연결 전에는 등록할 수 없어요." : "대기 운영 상태를 확인하고 있어요."}</p>}
    {snapshot && !snapshot.enabled && <p className="queue-notice">대기제는 준비 중이에요. 학교 로그인과 이 기기의 알림 설정은 미리 할 수 있어요. 현재는 기기를 직접 확인하고 시간을 등록해 주세요.</p>}
      {snapshot?.enabled && snapshot.paused && <p className="queue-notice" role="status">새 대기와 배정을 잠시 멈췄어요. 진행 중인 이용과 수거 기록은 유지돼요.</p>}
      {!auth?.user ? <VStack gap={3} hAlign="start"><p>{snapshot?.enabled ? "학교 Google 계정으로 로그인하면 대기에 참여하고 내 빨래의 수거 알림을 받을 수 있어요." : "학교 Google 계정으로 로그인하고 이 기기의 알림을 미리 설정해 주세요."}</p>{auth?.configured ? <a className="queue-login" href={loginHref}>학교 Google 계정으로 로그인</a> : <p className="queue-muted">학교 로그인 연결을 준비하고 있어요.</p>}</VStack> : <>
        <HStack gap={2} hAlign="between" vAlign="center" wrap="wrap"><span className="queue-account">{auth.user.email}</span><Button variant="ghost" label="로그아웃" isDisabled={disabled} onClick={() => void queue.logout()} /></HStack>
        {snapshot?.enabled && (tickets.length > 0 || runs.length > 0) && <VStack as="ul" gap={0} className="queue-list" aria-label="내 대기표와 사용">
          {tickets.filter((ticket) => ticket.state === "called").map((ticket) => <TicketRow key={`${ticket.id}:${ticket.callId}`} ticket={ticket} queue={queue} selectedMachineId={selectedMachineId} fromQr={fromQr} />)}
          {runs.map((run) => <RunRow key={run.id} run={run} queue={queue} />)}
          {tickets.filter((ticket) => !["called", "in_use", "pickup"].includes(ticket.state)).map((ticket) => <TicketRow key={`${ticket.id}:${ticket.state}`} ticket={ticket} queue={queue} selectedMachineId={selectedMachineId} fromQr={fromQr} />)}
        </VStack>}
        <p className="queue-muted">로그아웃하면 이 기기의 알림도 꺼져요. 진행 중 대기는 유지돼요.</p>
        <details className="queue-details" open={!pushReady}><summary>{pushReady ? "이 기기의 알림 설정 확인" : "알림 설정이 필요해요"}</summary><VStack gap={2} className="queue-push">
          <HStack gap={3} hAlign="between" vAlign="center" wrap="wrap"><HStack as="span" gap={2} vAlign="center"><Bell size={17} /><strong>{pushReady ? "이 기기 알림이 켜져 있어요" : "먼저 이 기기의 알림을 켜 주세요"}</strong></HStack><Button variant="secondary" label={pushReady ? "시험 알림 보내기" : "알림 켜기"} isDisabled={disabled || !push?.configured || (!pushReady && capability.permission === "denied")} onClick={() => void (pushReady ? queue.testPush() : queue.enablePush())} /></HStack>
          <p className="queue-muted">수거할 사람과 다음 이용자 모두에게 알려 드려요. 알림 발송이 실제 확인을 뜻하지는 않아요.</p>
          {!push?.configured && <p className="queue-muted">알림 서버 설정을 준비하고 있어요. 설정이 완료되면 대기에 참여할 수 있어요.</p>}
          {capability.iosNeedsInstall && <p className="queue-notice">아이폰과 아이패드는 Safari의 공유 메뉴에서 ‘홈 화면에 추가’를 선택해 주세요. 추가한 앱을 열고 알림을 허용해야 화면을 닫아도 받을 수 있어요.</p>}
          {!capability.available && !capability.iosNeedsInstall && <p className="queue-notice">이 브라우저는 기기 알림을 지원하지 않아요. 알림을 지원하는 브라우저로 열어 주세요.</p>}
          {capability.permission === "denied" && <p className="queue-notice">알림이 차단되어 있어요. 브라우저의 이 사이트 설정에서 알림을 허용한 뒤 새로고침해 주세요.</p>}
        </VStack></details>
        {snapshot?.enabled && <>
        <Grid columns={{ minWidth: 260, max: 2 }} gap={4}>
          {(["washer", "dryer"] as const).map((type) => {
            const used = tickets.filter((ticket) => ticket.type === type).length;
            return <VStack key={type} gap={2} className="queue-join"><HStack hAlign="between" gap={2}><strong>{type === "washer" ? "세탁" : "건조"} 대기</strong><span className="queue-muted">내 이용 {used}/2</span></HStack><p className="queue-muted">{type === "washer" ? "지금 바로 사용할 준비가 됐다면 등록하세요." : "세탁 중에도 등록하고, 각 대기표에서 준비 완료를 눌러 주세요."}</p><Button variant="secondary" label={`${type === "washer" ? "세탁" : "건조"} 대기표 받기`} isDisabled={disabled || snapshot.paused || !pushReady || used >= 2} onClick={() => void queue.command({ action: "join", type }, type === "washer" ? "세탁 대기표를 받았어요." : "건조 대기표를 받았어요. 사용할 수 있을 때 준비 완료를 눌러 주세요.")} /><span className="queue-muted">공용 대기 {snapshot.counts[type]}장</span></VStack>;
          })}
        </Grid>
        <p className="queue-muted">대기부터 수거까지 종류별로 2대까지 이용할 수 있어요. 준비 전 대기표는 순번을 유지하며 건너뛰어요.</p>
        {tickets.length === 0 && runs.length === 0 && <p className="queue-empty">아직 내 대기표가 없어요.</p>}
        <QueueHistory reports={snapshot.reports} tickets={snapshot.tickets.filter((ticket) => !activeStates.includes(ticket.state))} />
        {auth.user.isAdmin && <AdminPanel queue={queue} />}
        </>}
      </>}
      {snapshot?.enabled && <p className="queue-muted">호출 후 5분 안에 기기 앞에서 QR을 열고 시작해 주세요. 알림 전송 후 응답하지 않아 만료되면 재등록은 맨 뒤예요. 알림을 보내지 못한 경우에는 원래 순번으로 보류해요.</p>}
  </VStack>;
}

function TicketRow({ ticket, queue, selectedMachineId, fromQr }: { ticket: QueueTicketView; queue: QueueController; selectedMachineId: string | null; fromQr: boolean }) {
  const [confirmed, setConfirmed] = useState(false);
  const { busy, offline, now } = queue;
  const disabled = busy || offline;
  const atMachine = fromQr && ticket.machineId === selectedMachineId;
  const called = ticket.state === "called" && ticket.callId && ticket.machineId;
  const activeCall = Boolean(called && ticket.expiresAt && ticket.expiresAt > now);
  useEffect(() => {
    if (!fromQr || selectedMachineId !== ticket.machineId || ticket.state !== "called") return;
    const timer = window.setTimeout(() => {
      const row = document.getElementById(`queue-call-${ticket.id}`);
      row?.focus({ preventScroll: true });
      row?.scrollIntoView({ block: "start", behavior: "instant" });
    }, 0);
    return () => clearTimeout(timer);
  }, [fromQr, selectedMachineId, ticket.id, ticket.callId, ticket.machineId, ticket.state]);
  const report = (kind: "uncollected" | "still_running" | "fault") => {
    if (!ticket.callId || !ticket.machineId) return;
    void queue.command({ action: "report", ticketId: ticket.id, callId: ticket.callId, machineId: ticket.machineId, kind }, "확인 기록을 남겼어요. 원래 순번을 유지하며 다른 기기를 기다립니다.");
  };
  return <VStack as="li" id={`queue-call-${ticket.id}`} tabIndex={-1} gap={3} paddingBlock={4} className={called ? "queue-row queue-called" : "queue-row"}>
    <HStack gap={2} hAlign="between" vAlign="center" wrap="wrap"><strong>{ticket.type === "washer" ? "세탁" : "건조"} 대기표 #{ticket.sequence}</strong><HStack as="span" gap={2} vAlign="center"><StatusDot variant={called ? "accent" : "neutral"} label={ticketLabels[ticket.state]} />{ticketLabels[ticket.state]}</HStack></HStack>
    {ticket.state === "waiting" && <p>{ticket.ahead === 0 ? "앞에 준비된 대기표가 없어요. 기기가 준비되면 알려 드려요." : `앞에 준비된 대기표 ${ticket.ahead ?? 0}장이 있어요.`}</p>}
    {ticket.state === "preparing" && <p className="queue-muted">아직 호출하지 않아요. 지금 사용할 수 있을 때 준비 완료를 눌러 주세요.</p>}
    {ticket.state === "paused" && <p className="queue-notice">알림을 보내지 못해 원래 순번으로 보류했어요. 알림 설정을 확인한 뒤 대기를 재개해 주세요.</p>}
    {called && <>
      <HStack gap={3} hAlign="between" wrap="wrap"><strong>{machineLabel(ticket.machineId!)}</strong><span className="queue-deadline">{activeCall ? `${remaining(ticket.expiresAt!, now)} 안에 시작` : "호출 기한이 지났어요"}</span></HStack>
      <p>배정된 기기를 현장에서 확인해 주세요. 빈 기기인지 확인한 뒤 실제 기기를 켜고 시작을 등록하세요.</p>
      {!atMachine ? <HStack gap={2} vAlign="start" className="queue-notice"><QrCode size={18} /><span>배정된 기기에 붙은 QR을 열어 주세요. 현황판에서 기기를 선택하는 것으로는 시작할 수 없어요.</span></HStack> : <>
        <label className="queue-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} disabled={disabled || !activeCall} /><span>기기가 비어 있는 것을 확인했고, 내 빨래를 넣고 실제로 작동시켰어요.</span></label>
        <Button variant="primary" label="빈 상태 확인하고 시작 등록" isDisabled={disabled || !activeCall || !confirmed} onClick={() => void queue.command({ action: "start", ticketId: ticket.id, callId: ticket.callId!, machineId: ticket.machineId! }, "시작을 등록했어요. 예상 시간이 끝나면 수거 알림을 보내 드려요.")} />
        <details className="queue-details"><summary>기기를 사용할 수 없나요?</summary><VStack gap={2} paddingBlockStart={3}><p className="queue-muted">현장에서 확인한 상태만 남겨 주세요. 5분을 기다릴 필요는 없어요.</p><Button variant="secondary" label="작동은 끝났지만 빨래가 남아 있어요" isDisabled={disabled || !activeCall} onClick={() => report("uncollected")} /><Button variant="secondary" label="아직 작동 중이에요" isDisabled={disabled || !activeCall} onClick={() => report("still_running")} /><Button variant="secondary" label="기기가 고장 났어요" isDisabled={disabled || !activeCall} onClick={() => report("fault")} /><p className="queue-muted">미수거 확인은 자동 벌점이 아니에요. 아직 작동 중인 경우에는 미수거로 세지 않아요.</p></VStack></details>
      </>}
    </>}
    <HStack gap={2} wrap="wrap">{(ticket.state === "preparing" || ticket.state === "paused") && <Button variant="primary" label={ticket.state === "paused" ? "알림 확인 후 대기 재개" : "지금 사용할 준비 완료"} isDisabled={disabled || !queue.pushReady || queue.snapshot?.paused} onClick={() => void queue.command({ action: "ready", ticketId: ticket.id }, "준비 완료로 바꿨어요. 원래 접수 순서대로 기다립니다.")} />}<Button variant="ghost" label="이 대기표 취소" isDisabled={disabled} onClick={() => void queue.command({ action: "cancel", ticketId: ticket.id }, "대기표를 취소했어요.")} /></HStack>
  </VStack>;
}

function RunRow({ run, queue }: { run: QueueRunView; queue: QueueController }) {
  const [minutes, setMinutes] = useState("");
  const needsPickup = run.status === "pickup" || run.endsAt <= queue.now;
  return <VStack as="li" gap={3} paddingBlock={4} className="queue-row">
    <HStack gap={2} hAlign="between" wrap="wrap"><strong>{machineLabel(run.machineId)}</strong><HStack as="span" gap={2} vAlign="center"><StatusDot variant={needsPickup ? "warning" : "success"} label={needsPickup ? "수거 대기" : "사용 중"} />{needsPickup ? "빨래를 수거해 주세요" : `예상 ${remaining(run.endsAt, queue.now)} 남음`}</HStack></HStack>
    <p className="queue-muted">{needsPickup ? "예상 시간이 끝났어요. 실제 작동이 끝났는지 확인하고 빨래를 모두 꺼내 주세요." : `${time(run.endsAt)} 종료 예상`}</p>
    <Button variant={needsPickup ? "primary" : "secondary"} label="빨래를 모두 꺼냈어요" isDisabled={queue.busy || queue.offline} onClick={() => void queue.command({ action: "pickup", runId: run.id, expectedVersion: run.version }, "수거 완료를 기록했어요. 다음 순번에 배정합니다.")} />
    <details className="queue-details"><summary>기기 표시창과 시간이 다른가요?</summary><VStack as="form" gap={2} paddingBlockStart={3} onSubmit={(event: React.FormEvent) => { event.preventDefault(); const value = Number(minutes); if (!Number.isInteger(value) || value < 1 || value > 180) { queue.setError("남은 시간을 1분부터 180분 사이로 입력해 주세요."); return; } void queue.command({ action: "adjust", runId: run.id, expectedVersion: run.version, minutes: value }, "남은 시간을 수정했어요. 이미 호출한 이용자의 순번은 유지돼요."); }}><label htmlFor={`queue-minutes-${run.id}`}>표시창의 남은 시간</label><HStack gap={2} vAlign="center"><input id={`queue-minutes-${run.id}`} className="queue-minutes" type="number" inputMode="numeric" min={1} max={180} required value={minutes} onChange={(event) => setMinutes(event.target.value)} disabled={queue.busy || queue.offline} /><span>분</span><Button type="submit" label="시간 수정" isDisabled={queue.busy || queue.offline} /></HStack></VStack></details>
  </VStack>;
}

export function QueueMachineActions({ queue, machineId, fromQr }: { queue: QueueController; machineId: string; fromQr: boolean }) {
  const [confirmed, setConfirmed] = useState(false);
  const machine = queue.snapshot?.machines.find((item) => item.id === machineId);
  const ticket = queue.snapshot?.tickets.find((item) => item.machineId === machineId && item.state === "called");
  const eligible = Boolean(queue.auth?.user?.isAdmin || queue.snapshot?.tickets.some((item) => item.type === machine?.type && ["preparing", "waiting", "called", "paused"].includes(item.state)));
  return <VStack gap={3} paddingBlock={4}>
    <p>{machine ? queueMachineLabels[machine.status] : "대기 현황을 확인하고 있어요."}{machine?.called ? " 다음 이용자가 확인하러 오고 있어요." : ""}</p>
    {ticket ? <><p>이 기기로 호출받으셨어요. 내 대기표에서 현장 확인 후 시작해 주세요.</p><a className="queue-text-link" href="#my-queue">내 대기표로 이동</a></> : <p className="queue-muted">이 구역에서는 공용 대기표로 배정받은 뒤 시작해요.</p>}
    {machine && ["unknown", "blocked", "check"].includes(machine.status) && eligible && <>
      {!fromQr ? <p className="queue-muted">현장에서 빈 기기를 확인하려면 해당 기기의 QR을 열어 주세요.</p> : <><label className="queue-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} disabled={queue.busy || queue.offline} /><span>기기 앞에서 작동이 끝났고 빨래도 없는 것을 확인했어요.</span></label><Button label="현장 빈 기기 확인" isDisabled={queue.busy || queue.offline || !confirmed} onClick={() => void queue.command({ action: "confirm_empty", machineId, expectedVersion: machine.version }, "빈 기기를 확인했어요. 준비된 대기표 중 가장 앞선 순번에 배정합니다.")} /><p className="queue-muted">확인한 사람에게 우선권이 생기지 않아요.</p></>}
    </>}
    {!queue.auth?.user && <a className="queue-text-link" href="#my-queue">로그인하고 대기 참여하기</a>}
  </VStack>;
}

function QueueHistory({ reports, tickets = [] }: { reports: (QueueReportView & { reporterId?: string; ownerId?: string | null; callId?: string })[]; tickets?: QueueTicketView[] }) {
  return <details className="queue-details"><summary>처리 이력 {reports.length + tickets.length}건</summary><p className="queue-muted">진행 중 기록과 최근 종료 이력을 보여 드려요. 해결된 현장 확인 기록도 보존해요.</p><VStack as="ul" gap={0} className="queue-list">
    {reports.length === 0 && tickets.length === 0 && <li className="queue-muted">아직 처리 이력이 없어요.</li>}
    {reports.map((report) => <VStack as="li" gap={1} paddingBlock={3} className="queue-row" key={report.id}><HStack gap={2} hAlign="between" wrap="wrap"><strong>{machineLabel(report.machineId)}: {reportLabels[report.kind]}</strong><span>{report.resolvedAt ? "해결됨" : "확인 대기"}</span></HStack><p className="queue-muted">{report.role === "owner" ? "내 사용 건에 접수된 확인" : report.role === "reporter" ? "내가 남긴 확인" : "운영진 조회"} / 호출 {time(report.calledAt)} / 확인 {time(report.reportedAt)}</p><p className="queue-muted">당시 예상 종료 {report.expectedEndAt ? time(report.expectedEndAt) : "정보 없음"}{report.resolvedAt ? ` / 수거 또는 빈 기기 확인 ${time(report.resolvedAt)}` : ""}</p>{report.reporterId !== undefined && <details><summary>기록 식별 정보</summary><p className="queue-muted">기기: {report.machineId}<br />사용 기록: {report.runId}<br />호출: {report.callId ?? "정보 없음"}<br />확인 기록: {report.id}<br />확인한 이용자: {report.reporterId ?? "정보 없음"}<br />사용한 이용자: {report.ownerId ?? "기존 익명 사용"}</p></details>}</VStack>)}
    {tickets.map((ticket) => <HStack as="li" key={ticket.id} paddingBlock={3} gap={2} hAlign="between" wrap="wrap" className="queue-row"><span>{ticket.type === "washer" ? "세탁" : "건조"} 대기표 #{ticket.sequence}</span><span className="queue-muted">{ticketLabels[ticket.state]} / 접수 {time(ticket.createdAt)}</span></HStack>)}
  </VStack></details>;
}

function AdminPanel({ queue }: { queue: QueueController }) {
  const [reports, setReports] = useState<QueueReportView[] | null>(null);
  const [loading, setLoading] = useState(false);
  async function load() {
    setLoading(true);
    try {
      const response = await fetch("/api/queue/admin", { cache: "no-store", signal: AbortSignal.timeout(12_000) });
      const body = await response.json() as { reports: QueueReportView[]; error?: string };
      if (!response.ok) throw new Error(body.error || "운영 이력을 불러오지 못했어요.");
      setReports(body.reports);
    } catch (cause) { queue.setError(cause instanceof Error ? cause.message : "운영 이력을 불러오지 못했어요."); }
    finally { setLoading(false); }
  }
  const faults = queue.snapshot?.machines.filter((machine) => machine.status === "fault") ?? [];
  return <details className="queue-details"><summary>운영진 관리</summary><VStack gap={3} paddingBlockStart={3}>
    <p className="queue-muted">진행 중 기록 전체와 최근 종료 기록 200건을 조회해요. 새 대기와 배정을 멈춰도 진행 중인 사용과 기록은 유지돼요. 고장 복구는 실제 기기가 정상이며 비어 있는지 확인한 뒤 눌러 주세요.</p>
    <HStack gap={2} wrap="wrap"><Button label={queue.snapshot?.paused ? "대기 운영 재개" : "새 대기와 배정 중단"} isDisabled={queue.busy || queue.offline} onClick={() => void queue.command({ action: queue.snapshot?.paused ? "resume" : "pause" })} /><Button label="상세 이력 불러오기" isLoading={loading} onClick={() => void load()} /></HStack>
    {faults.map((machine) => <RecoveryRow key={machine.id} machine={machine} queue={queue} />)}
    {reports && <QueueHistory reports={reports} />}
  </VStack></details>;
}
function RecoveryRow({ machine, queue }: { machine: QueueMachineView; queue: QueueController }) {
  const [confirmed, setConfirmed] = useState(false);
  return <VStack gap={2}><label className="queue-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>{machineLabel(machine.id)}가 정상이며 비어 있는 것을 확인했어요.</span></label><Button label={`${machineLabel(machine.id)} 복구`} icon={<Check size={16} />} isDisabled={!confirmed || queue.busy || queue.offline} onClick={() => void queue.command({ action: "recover", machineId: machine.id, expectedVersion: machine.version })} /></VStack>;
}
