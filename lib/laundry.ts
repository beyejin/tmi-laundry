export const MACHINES = [
  { id: "washer-1", name: "세탁기 1", type: "washer", defaultMinutes: 36 },
  { id: "washer-2", name: "세탁기 2", type: "washer", defaultMinutes: 36 },
  { id: "dryer-1", name: "건조기 1", type: "dryer", defaultMinutes: 45 },
] as const;

export type MachineId = (typeof MACHINES)[number]["id"];
export type Command = { action: "start" | "adjust" | "clear"; expectedVersion: number; minutes?: number };
export type StateRow = { id: string; ends_at: number | null; updated_at: number; version: number };

export function findMachine(id: string) {
  return MACHINES.find((machine) => machine.id === id);
}

export function parseCommand(value: unknown): Command | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (!["start", "adjust", "clear"].includes(String(input.action))) return null;
  if (!Number.isSafeInteger(input.expectedVersion) || Number(input.expectedVersion) < 0) return null;
  if (input.action === "adjust" && (!Number.isInteger(input.minutes) || Number(input.minutes) < 1 || Number(input.minutes) > 180)) return null;
  return {
    action: input.action as Command["action"],
    expectedVersion: Number(input.expectedVersion),
    ...(input.action === "adjust" ? { minutes: Number(input.minutes) } : {}),
  };
}

export function stateSnapshot(rows: StateRow[], now: number) {
  return {
    serverTime: now,
    machines: MACHINES.map((machine) => {
      const row = rows.find((item) => item.id === machine.id);
      return { ...machine, endsAt: row?.ends_at ?? null, updatedAt: row?.updated_at ?? null, version: row?.version ?? 0 };
    }),
  };
}

export function mutationQuery(id: MachineId, command: Command, now: number) {
  const machine = findMachine(id)!;
  const endsAt = command.action === "clear" ? null : now + (command.action === "start" ? machine.defaultMinutes : command.minutes!) * 60_000;
  if (command.expectedVersion === 0) {
    return {
      sql: "INSERT INTO machine_state (id, ends_at, updated_at, version) VALUES (?1, ?2, ?3, 1) ON CONFLICT(id) DO NOTHING RETURNING *",
      values: [id, endsAt, now],
    };
  }
  return {
    sql: "UPDATE machine_state SET ends_at = ?2, updated_at = ?3, version = version + 1 WHERE id = ?1 AND version = ?4 AND (?5 <> 'start' OR ends_at IS NULL OR ends_at <= ?3) RETURNING *",
    values: [id, endsAt, now, command.expectedVersion, command.action],
  };
}
