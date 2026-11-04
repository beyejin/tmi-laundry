import { env } from "cloudflare:workers";
import { stateSnapshot, type StateRow } from "./laundry";
import { queueEnabled } from "./queue-config";
import { getPublicQueueMachines } from "./queue-store";

export function database() {
  if (!env.DB) throw new Error("Laundry database is unavailable");
  return env.DB;
}
export async function snapshotResponse() {
  const { results } = await database().prepare("SELECT id, ends_at, updated_at, version FROM machine_state").all<StateRow>();
  const snapshot = stateSnapshot(results, Date.now());
  const enabled = queueEnabled(env);
  const queueMachines = enabled ? await getPublicQueueMachines(database()) : [];
  return Response.json({
    ...snapshot, queueEnabled: enabled,
    machines: snapshot.machines.map((machine) => {
      const current = queueMachines.find((entry) => entry.id === machine.id);
      return current ? { ...machine, endsAt: current.endsAt, updatedAt: current.updatedAt, version: current.version, queueStatus: current.status, called: current.called } : machine;
    }),
  }, { headers: { "Cache-Control": "no-store" } });
}
export function errorResponse(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}
