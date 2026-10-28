"use client";

import { Bell } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { scheduleLabel, scheduledLabel } from "./done-alert";

export function DoneAlertButton({
  scheduled,
  minutesLeft,
  permission,
  pending,
  onSchedule,
  onCancel,
}: {
  scheduled: boolean;
  minutesLeft: number;
  permission: NotificationPermission | "unsupported";
  pending: boolean;
  onSchedule: () => void;
  onCancel: () => void;
}) {
  const visibleLabel = scheduled ? scheduledLabel(minutesLeft) : scheduleLabel;
  const granted = permission === "granted";
  const note = granted
    ? "이 화면과 브라우저로 알려 드릴게요. 다시 누르면 취소해요."
    : "브라우저 알림 없이 이 화면으로만 알려 드려요. 다시 누르면 취소해요.";

  return (
    <div className="done-alert" data-done-alert={scheduled ? "scheduled" : "ready"}>
      <Button
        className="secondary-button"
        variant="secondary"
        width="100%"
        icon={<Bell size={16} strokeWidth={1.8} aria-hidden />}
        label={scheduled ? `${visibleLabel}. 다시 누르면 알림을 취소해요.` : visibleLabel}
        aria-pressed={scheduled}
        aria-describedby={scheduled ? "done-alert-note" : undefined}
        isLoading={pending}
        onClick={scheduled ? onCancel : onSchedule}
      >
        {visibleLabel}
      </Button>
      {scheduled && (
        <p className="done-alert-note" id="done-alert-note">
          <StatusDot variant={granted ? "success" : "warning"} label={granted ? "브라우저 알림 포함" : "화면 알림만"} />
          <span>{note}</span>
        </p>
      )}
    </div>
  );
}
