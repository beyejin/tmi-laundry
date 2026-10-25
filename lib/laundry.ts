export const BUILDINGS = [2, 3] as const;
export const WINGS = [
  { id: "women", name: "여자" },
  { id: "men", name: "남자" },
] as const;

export type Location = {
  id: string;
  building: (typeof BUILDINGS)[number];
  wing: (typeof WINGS)[number]["id"];
  floor: number;
  label: string;
};

export const LOCATIONS: readonly Location[] = [
  { id: "h3-women-2", building: 3, wing: "women", floor: 2, label: "3생활관 여자 2층" },
  { id: "h3-women-3", building: 3, wing: "women", floor: 3, label: "3생활관 여자 3층" },
  { id: "h3-women-4", building: 3, wing: "women", floor: 4, label: "3생활관 여자 4층" },
  { id: "h3-women-5", building: 3, wing: "women", floor: 5, label: "3생활관 여자 5층" },
];

const EQUIPMENT = [
  { id: "washer-1", name: "세탁기 1", type: "washer", defaultMinutes: 36 },
  { id: "washer-2", name: "세탁기 2", type: "washer", defaultMinutes: 36 },
  { id: "dryer-1", name: "건조기 1", type: "dryer", defaultMinutes: 45 },
] as const;

export const MACHINES = LOCATIONS.flatMap((location) => EQUIPMENT.map((machine) => ({
  ...machine,
  id: `${location.id}-${machine.id}`,
  locationId: location.id,
})));

export type MachineId = (typeof MACHINES)[number]["id"];
export type Command = { action: "start" | "adjust" | "clear"; expectedVersion: number; minutes?: number };
export type StateRow = { id: string; ends_at: number | null; updated_at: number; version: number };

export function findLocation(id: string) {
  return LOCATIONS.find((location) => location.id === id);
}

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
  const machine = findMachine(id);
  if (!machine) throw new Error("등록되지 않은 기기예요.");
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
