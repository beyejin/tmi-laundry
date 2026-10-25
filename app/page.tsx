"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Info, QrCode, RefreshCw, WashingMachine, Wind, WifiOff, X } from "lucide-react";
import { AppShell } from "@astryxdesign/core/AppShell";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Grid } from "@astryxdesign/core/Grid";
import { Button } from "@astryxdesign/core/Button";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { MACHINES } from "@/lib/laundry";
import { useLaundry, type Machine } from "@/hooks/use-laundry";

type DialogState = { machine: Machine; action: "adjust" | "clear" };
type MachineStatus = "unknown" | "running" | "finished";

function remainingSeconds(machine: Machine, now: number) {
  return machine.endsAt === null ? null : Math.max(0, Math.ceil((machine.endsAt - now) / 1_000));
}

function machineStatus(machine: Machine, now: number): MachineStatus {
  const seconds = remainingSeconds(machine, now);
  return seconds === null ? "unknown" : seconds > 0 ? "running" : "finished";
}

const statusVariants = { unknown: "neutral", running: "success", finished: "warning" } as const;
const statusNames: Record<MachineStatus, string> = { unknown: "미확인", running: "등록된 사용 중", finished: "예상 종료" };

function timeLabel(time: number) {
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false }).format(time);
}

function countdown(seconds: number) {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export default function Home() {
  const { machines, loaded, currentTime, lastSync, connection, refreshing, pending, message, setMessage, refresh, updateMachine, actionsDisabled } = useLaundry();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fromQr, setFromQr] = useState(false);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [minutes, setMinutes] = useState("");
  const [actionError, setActionError] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const minutesRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const readSelection = () => {
      const id = new URLSearchParams(window.location.search).get("machine");
      const validId = MACHINES.some((machine) => machine.id === id) ? id : null;
      setSelectedId(validId);
      setFromQr(validId !== null);
    };
    const initialRead = window.setTimeout(readSelection, 0);
    window.addEventListener("popstate", readSelection);
    return () => { window.clearTimeout(initialRead); window.removeEventListener("popstate", readSelection); };
  }, []);

  useEffect(() => {
    if (dialog && !dialogRef.current?.open) {
      dialogRef.current?.showModal();
      if (dialog.action === "adjust") minutesRef.current?.focus();
    }
  }, [dialog]);

  function selectMachine(id: string | null) {
    setSelectedId(id);
    setFromQr(false);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("machine", id);
    else url.searchParams.delete("machine");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }

  function openDialog(machine: Machine, action: DialogState["action"]) {
    const seconds = remainingSeconds(machine, currentTime);
    setMinutes(String(seconds && seconds > 0 ? Math.ceil(seconds / 60) : machine.defaultMinutes));
    setActionError("");
    setDialog({ machine, action });
  }

  async function submitDialog() {
    if (!dialog) return;
    const value = Number(minutes);
    if (dialog.action === "adjust" && (!Number.isInteger(value) || value < 1 || value > 180)) {
      setActionError("남은 시간을 1분부터 180분 사이의 정수로 입력해 주세요.");
      return;
    }
    setActionError("");
    const result = await updateMachine(dialog.machine, dialog.action, dialog.action === "adjust" ? value : undefined);
    if (result.status === "failed") setActionError(result.error ?? "현황을 확인한 뒤 다시 시도해 주세요.");
    else dialogRef.current?.close();
  }

  const selected = machines.find((machine) => machine.id === selectedId);
  const selectedStatus = selected ? machineStatus(selected, currentTime) : "unknown";
  const counts = machines.reduce((total, machine) => { total[machineStatus(machine, currentTime)] += 1; return total; }, { running: 0, finished: 0, unknown: 0 });

  return (
    <>
      <a className="skip-link" href="#machine-status">기기 현황으로 바로 가기</a>
      <HStack as="header" hAlign="between" vAlign="center" className="site-header">
        <a className="brand" href="/" aria-label="TMI 세탁실 전체 현황"><WashingMachine size={23} strokeWidth={1.8} /><span>TMI 세탁실</span></a>
        <a className="header-link" href="/qr"><QrCode size={17} />QR 안내문</a>
      </HStack>

      <AppShell height="auto" variant="wash" mobileNav={false} contentPadding={0} className="page-shell">
        <HStack hAlign="between" vAlign="start" className="page-heading"><VStack gap={0}><h1>세탁실 현황</h1><p>기기를 선택하면 시작 등록과 시간 수정이 가능해요.</p></VStack><span className="floor-label">시범 운영층</span></HStack>

        {connection === "offline" && <HStack gap={2} vAlign="start" className="connection-warning" role="alert"><WifiOff size={19} /><VStack gap={0}><strong>연결이 끊어졌어요</strong><p>{lastSync ? `${timeLabel(lastSync)}에 확인한 마지막 정보예요. 현재 상태와 다를 수 있어요.` : "현황을 불러오지 못했어요. 연결을 확인해 주세요."} 연결되면 등록할 수 있어요.</p></VStack><button onClick={() => void refresh()} disabled={refreshing}>다시 연결</button></HStack>}

        <Grid columns={3} gap={0} className="summary" aria-label="등록 상태별 기기 수">
          {(["running", "finished", "unknown"] as const).map((status) => <HStack hAlign="between" vAlign="center" className={`summary-item status-${status}`} key={status}><span className="summary-label"><StatusDot variant={statusVariants[status]} label={statusNames[status]} />{statusNames[status]}</span><strong>{loaded ? counts[status] : "?"}<span>대</span></strong></HStack>)}
        </Grid>

        <HStack hAlign="between" vAlign="center" className="sync-row"><span className={`connection-label ${connection === "offline" ? "is-offline" : ""}`}><StatusDot variant={connection === "offline" ? "warning" : connection === "online" ? "success" : "neutral"} label={connection === "online" ? "연결됨" : "연결 확인 필요"} />{connection === "loading" ? "현황을 불러오는 중이에요" : connection === "offline" ? "마지막 등록 현황" : "10초마다 자동 확인"}</span><HStack gap={2} vAlign="center"><span className="sync-time">{lastSync ? `${timeLabel(lastSync)} 확인` : "연결 확인 중"}</span><button className="refresh-button" aria-label="기기 현황 새로고침" onClick={() => void refresh()} disabled={refreshing || pending !== null}><RefreshCw size={15} className={refreshing ? "is-spinning" : ""} /><span>새로고침</span></button></HStack></HStack>

        <Grid columns={2} gap={4} className="laundry-layout" style={{ gridTemplateColumns: "var(--laundry-columns)" }}>
          <section className="board" id="machine-status" aria-labelledby="board-title">
            <HStack hAlign="between" vAlign="center" className="board-heading"><h2 id="board-title">기기 현황</h2><span>기기를 눌러 선택해 주세요</span></HStack>
            <Grid columns={3} gap={2} className="machine-grid">
              {machines.map((machine) => {
                const status = machineStatus(machine, currentTime);
                const seconds = remainingSeconds(machine, currentTime);
                const isSelected = selectedId === machine.id;
                const Icon = machine.type === "dryer" ? Wind : WashingMachine;
                return <button type="button" key={machine.id} className={`machine-tile status-${status} ${isSelected ? "is-selected" : ""}`} aria-pressed={isSelected} aria-label={`${machine.name}, ${loaded ? statusNames[status] : "확인 중"}${status === "running" ? `, 예상 ${Math.floor(seconds! / 60)}분 ${seconds! % 60}초 남음` : ""}`} onClick={() => selectMachine(machine.id)}>
                  {isSelected && <span className="selected-check" aria-hidden="true"><Check size={12} strokeWidth={3} /></span>}
                  <Icon className="tile-icon" size={24} strokeWidth={1.65} />
                  <span className="tile-name">{machine.name}</span>
                  <HStack as="span" gap={1} hAlign="center" vAlign="center" className="tile-status"><StatusDot variant={statusVariants[status]} label={loaded ? statusNames[status] : "확인 중"} />{loaded ? statusNames[status] : "확인 중"}</HStack>
                  <span className={`tile-time ${status !== "running" ? "tile-time-text" : ""}`}>{!loaded ? "확인 중" : status === "running" ? countdown(seconds!) : status === "finished" ? "종료" : "미등록"}</span>
                  <span className="tile-time-caption">{status === "running" ? "예상 남은 시간" : status === "finished" ? "수거 여부 미확인" : "사용 여부 미확인"}</span>
                  <span className="tile-default">기본 {machine.defaultMinutes}분</span>
                </button>;
              })}
            </Grid>
            <p className="board-note"><Info size={15} /><span>사용자가 등록한 예상 시간이에요.<br />미확인이나 예상 종료가 빈 기기를 뜻하지는 않아요.</span></p>
          </section>

          <VStack as="section" gap={0} className={`detail-panel ${selected ? "has-selection" : ""}`} aria-labelledby="detail-title">
            {selected ? <>
              <HStack hAlign="between" vAlign="center" className="detail-heading"><VStack gap={0}><span className="detail-eyebrow">{fromQr ? "QR로 선택한 기기" : "선택한 기기"}</span><h2 id="detail-title">{selected.name}</h2></VStack><span className={`detail-status status-${selectedStatus}`}><StatusDot variant={statusVariants[selectedStatus]} label={statusNames[selectedStatus]} />{loaded ? statusNames[selectedStatus] : "확인 중"}</span></HStack>
              <HStack hAlign="between" wrap="wrap" className="detail-readout"><span>{!loaded ? "현황을 확인하고 있어요." : selectedStatus === "running" ? `${timeLabel(selected.endsAt!)} 종료 예상` : selectedStatus === "finished" ? "빨래가 남아 있을 수 있어요." : "등록된 시간 정보가 없어요."}</span><span>기본 {selected.defaultMinutes}분</span></HStack>
              <p className="start-instruction">기기를 실제로 켠 뒤 시작을 눌러 주세요.</p>
              <Button className="primary-button" variant="primary" label={pending === selected.id ? "저장 중이에요" : selectedStatus === "running" ? "시작이 등록됐어요" : `${selected.defaultMinutes}분 시작`} isDisabled={actionsDisabled || selectedStatus === "running"} isLoading={pending === selected.id} onClick={() => void updateMachine(selected, "start")} />
              <Button className="secondary-button" variant="secondary" label={selected.endsAt === null ? "남은 시간 직접 입력" : "남은 시간 수정"} isDisabled={actionsDisabled} onClick={() => openDialog(selected, "adjust")} />
              <HStack hAlign="between" vAlign="center" className="detail-footer"><span>{selected.updatedAt ? `${timeLabel(selected.updatedAt)} 등록 정보 갱신` : "웹에서 실제 기기를 켜거나 끌 수는 없어요"}</span>{selected.endsAt !== null && <button className="clear-button" disabled={actionsDisabled} onClick={() => openDialog(selected, "clear")}>등록 취소</button>}</HStack>
            </> : <VStack gap={0} hAlign="center" vAlign="center" className="empty-selection"><span><WashingMachine size={28} strokeWidth={1.4} /></span><h2 id="detail-title">등록할 기기를 선택해 주세요.</h2><p>현황판의 기기를 누르면<br />시작 등록과 시간 수정이 가능해요.</p></VStack>}
          </VStack>
        </Grid>

        <HStack as="footer" hAlign="between" className="site-footer"><span>세탁기 2대와 건조기 1대 시범 운영</span><span>TMI</span></HStack>
      </AppShell>

      <HStack hAlign="between" vAlign="center" className={`notification ${message ? "notification-visible" : ""}`} role="status" aria-live="polite" aria-atomic="true">{message && <><span>{message}</span><button aria-label="안내 닫기" onClick={() => setMessage("")}><X size={18} /></button></>}</HStack>

      <dialog ref={dialogRef} className="edit-dialog" onCancel={(event) => { if (pending !== null) event.preventDefault(); }} onClose={() => { setDialog(null); setActionError(""); }} aria-labelledby="dialog-title" aria-describedby="dialog-description">
        {dialog && <form onSubmit={(event) => { event.preventDefault(); void submitDialog(); }}>
          <HStack hAlign="between" vAlign="center" className="dialog-top"><span>{dialog.machine.name}</span><button className="icon-button" type="button" aria-label="창 닫기" onClick={() => dialogRef.current?.close()} disabled={pending !== null}><X size={20} /></button></HStack>
          <h2 id="dialog-title">{dialog.action === "adjust" ? "남은 시간을 알려 주세요." : "등록을 취소할까요?"}</h2>
          <p id="dialog-description">{dialog.action === "adjust" ? "기기 표시창에 보이는 남은 시간을 입력해 주세요." : "시간 기록을 지우면 이 기기는 미확인으로 표시돼요. 실제 기기의 작동은 멈추지 않아요."}</p>
          {dialog.action === "adjust" && <VStack gap={0} className="minutes-field"><label htmlFor="remaining-minutes">남은 시간</label><HStack gap={3} vAlign="center"><input ref={minutesRef} id="remaining-minutes" type="number" inputMode="numeric" min="1" max="180" step="1" required value={minutes} onChange={(event) => setMinutes(event.target.value)} disabled={pending !== null} /><span>분</span></HStack><small>1분부터 180분까지 입력할 수 있어요.</small></VStack>}
          {actionError && <p className="dialog-error" role="alert">{actionError}</p>}
          {connection === "offline" && <p className="dialog-error" role="alert">연결이 끊어졌어요. 연결 후 다시 시도해 주세요.</p>}
          <Grid columns={2} gap={2} className="dialog-actions"><Button className="secondary-button" variant="secondary" label="돌아가기" type="button" onClick={() => dialogRef.current?.close()} isDisabled={pending !== null} /><Button className="primary-button" variant="primary" label={pending ? "저장 중이에요" : dialog.action === "adjust" ? "시간 저장" : "등록 취소"} type="submit" isDisabled={actionsDisabled} isLoading={pending !== null} /></Grid>
        </form>}
      </dialog>
    </>
  );
}
