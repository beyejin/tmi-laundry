"use client";

import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import type { MachineOrder } from "@/app/proto/empty-first";

export function EmptyFirstBar({
  mode,
  onMode,
  loaded,
  washers,
  dryers,
  isDisabled,
}: {
  mode: MachineOrder;
  onMode: (mode: MachineOrder) => void;
  loaded: boolean;
  washers: number;
  dryers: number;
  isDisabled: boolean;
}) {
  const washerCount = loaded ? String(washers) : "?";
  const dryerCount = loaded ? String(dryers) : "?";
  return (
    <VStack gap={3} className="empty-first-bar">
      <SegmentedControl label="기기 순서" value={mode} onChange={(value) => onMode(value === "number" ? "number" : "available")} size="md" layout="fill" isDisabled={isDisabled}>
        <SegmentedControlItem value="available" label="빈 기기 먼저" />
        <SegmentedControlItem value="number" label="기기 번호순" />
      </SegmentedControl>
      <HStack gap={2} vAlign="center" className="empty-first-summary" aria-live="polite">
        <StatusDot variant="success" label="지금 쓸 수 있는 기기" />
        <span>빈 세탁기 {washerCount}대, 빈 건조기 {dryerCount}대</span>
      </HStack>
    </VStack>
  );
}
