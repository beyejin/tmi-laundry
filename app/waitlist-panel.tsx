"use client";

import { useState } from "react";
import { Clock, Users, Wind } from "lucide-react";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Button } from "@astryxdesign/core/Button";
import type { Machine } from "@/hooks/use-laundry";
import { formatSinceEnd, machineStatus } from "@/lib/laundry";
import { NICKNAME_MAX, WAITLIST_LIMIT, estimateTurns, type WaitlistEntry } from "@/lib/waitlist";

function timeLabel(time: number) {
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false }).format(time);
}

export function DryerCard({ dryers, waiting, loaded, currentTime }: { dryers: Machine[]; waiting: number; loaded: boolean; currentTime: number }) {
  return <section className="dryer-card" aria-labelledby="dryer-card-title">
    <HStack hAlign="between" vAlign="center" className="dryer-card-heading"><h2 id="dryer-card-title"><Wind size={18} />건조기 완료 예정</h2><span className="dryer-waiting"><Users size={15} />대기 {loaded ? waiting : "?"}명</span></HStack>
    <VStack gap={1} className="dryer-card-list">
      {dryers.map((dryer) => {
        const status = machineStatus(dryer.endsAt, currentTime);
        const seconds = dryer.endsAt === null ? null : Math.max(0, Math.ceil((dryer.endsAt - currentTime) / 1_000));
        const text = !loaded ? "현황을 확인하고 있어요." : status === "unknown" ? "등록된 사용이 없어요" : status === "running" ? `${timeLabel(dryer.endsAt!)} 완료 예정 (약 ${Math.ceil(seconds! / 60)}분 남음)` : status === "stale" ? `확인 필요 · 끝난 지 ${formatSinceEnd(dryer.endsAt!, currentTime)}` : "예상 종료 · 수거 여부 미확인";
        return <p key={dryer.id} className="dryer-line"><strong>{dryer.name}</strong><span>{text}</span></p>;
      })}
    </VStack>
  </section>;
}

type PanelProps = {
  locationId: string;
  locationLabel: string;
  dryer: Machine | undefined;
  entries: WaitlistEntry[];
  mine: Record<string, string>;
  currentTime: number;
  loaded: boolean;
  disabled: boolean;
  onJoin: (locationId: string, nickname: string) => Promise<boolean>;
  onLeave: (entryId: string) => Promise<boolean>;
};

export function WaitlistPanel({ locationId, locationLabel, dryer, entries, mine, currentTime, loaded, disabled, onJoin, onLeave }: PanelProps) {
  const [nickname, setNickname] = useState("");
  const turns = dryer ? estimateTurns(dryer, entries.length, currentTime) : [];
  const hasMine = entries.some((entry) => mine[entry.id]);
  const full = entries.length >= WAITLIST_LIMIT;
  const blocked = disabled || full || hasMine || !loaded;
  const hint = hasMine ? "이 층에는 이미 대기 중이에요." : full ? `대기는 최대 ${WAITLIST_LIMIT}명까지예요.` : "";

  async function submit() {
    if (blocked || !nickname.trim()) return;
    if (await onJoin(locationId, nickname)) setNickname("");
  }

  return <section className="waitlist" aria-labelledby="waitlist-title">
    <HStack hAlign="between" vAlign="center" className="waitlist-heading"><h2 id="waitlist-title">건조기 대기자 명단</h2><span>{locationLabel} · {entries.length}/{WAITLIST_LIMIT}명</span></HStack>
    {entries.length ? <ol className="waitlist-list">
      {entries.map((entry, index) => {
        const isMine = Boolean(mine[entry.id]);
        return <li key={entry.id} className={`waitlist-item ${isMine ? "is-mine" : ""}`}>
          <span className="waitlist-position" aria-label={`${index + 1}번째`}>{index + 1}</span>
          <VStack gap={0} className="waitlist-body">
            <span className="waitlist-name"><strong>{entry.nickname}</strong>{isMine && <em className="waitlist-badge">나</em>}</span>
            <span className="waitlist-meta"><Clock size={13} />{timeLabel(entry.createdAt)} 등록{turns[index] !== undefined && <> · {timeLabel(turns[index])}쯤 차례 예상</>}</span>
          </VStack>
          {isMine && <button type="button" className="waitlist-cancel" disabled={disabled} onClick={() => void onLeave(entry.id)}>대기 취소</button>}
        </li>;
      })}
    </ol> : <p className="waitlist-empty">{loaded ? "대기하는 사람이 없어요." : "대기 명단을 확인하고 있어요."}</p>}
    <form className="waitlist-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label htmlFor="waitlist-nickname">별명</label>
      <div className="waitlist-form-row">
        <input id="waitlist-nickname" type="text" maxLength={NICKNAME_MAX} placeholder="호실 끝자리나 별명" autoComplete="off" value={nickname} onChange={(event) => setNickname(event.target.value)} disabled={blocked} />
        <Button className="primary-button waitlist-submit" variant="primary" type="submit" label="대기 명단에 올리기" isDisabled={blocked || !nickname.trim()} />
      </div>
      {hint && <small className="waitlist-hint">{hint}</small>}
    </form>
    <p className="waitlist-note">이름 대신 별명을 써 주세요. 3시간이 지나면 명단에서 자동으로 사라져요. 예상 시각은 등록된 시간 기준 추정이에요.</p>
  </section>;
}
