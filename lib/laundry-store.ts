import { env } from "cloudflare:workers";
import { stateSnapshot, type StateRow } from "./laundry";

export function database() {
  if (!env.DB) throw new Error("Laundry database is unavailable");
  return env.DB;
}

export async function snapshotResponse() {
  const { results } = await database().prepare("SELECT id, ends_at, updated_at, version FROM machine_state").all<StateRow>();
  return Response.json(stateSnapshot(results, Date.now()), { headers: { "Cache-Control": "no-store" } });
}

export function errorResponse(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}
