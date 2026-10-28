export type RegisteredStatus = "unknown" | "running" | "finished";
export type MachineOrder = "available" | "number";

export type SortableMachine = {
  status: RegisteredStatus;
  remainingSeconds: number | null;
};

/**
 * 등록이 없는 기기만 빈 기기로 봐요.
 * 예상 종료는 종료 시각이 지난 등록이고, 빨래가 남아 있을 수 있어 빈 기기가 아니에요.
 */
export function isAvailableNow(machine: SortableMachine) {
  return machine.status === "unknown";
}

function availabilityRank(machine: SortableMachine) {
  if (machine.status === "unknown") return 0;
  if (machine.status === "running") return 1;
  return 2;
}

export function compareAvailableFirst(a: SortableMachine, b: SortableMachine) {
  const byRank = availabilityRank(a) - availabilityRank(b);
  if (byRank !== 0) return byRank;
  if (a.status === "running" && b.status === "running") {
    return (a.remainingSeconds ?? Number.POSITIVE_INFINITY) - (b.remainingSeconds ?? Number.POSITIVE_INFINITY);
  }
  return 0;
}

export function orderMachines<T extends SortableMachine>(machines: readonly T[], mode: MachineOrder) {
  if (mode === "number") return machines;
  return [...machines].sort(compareAvailableFirst);
}

export function countAvailable(machines: readonly (SortableMachine & { type: "washer" | "dryer" })[]) {
  return machines.reduce(
    (total, machine) => {
      if (!isAvailableNow(machine)) return total;
      total[machine.type] += 1;
      return total;
    },
    { washer: 0, dryer: 0 },
  );
}
