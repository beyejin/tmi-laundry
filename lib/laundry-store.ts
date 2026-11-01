import { env } from "cloudflare:workers";
import { stateSnapshot, type StateRow } from "./laundry";
import { WAITLIST_TTL_MS, waitlistSnapshot, type WaitlistRow } from "./waitlist";

export function database() {
  if (!env.DB) throw new Error("Laundry database is unavailable");
  return env.DB;
}

export async function readSnapshot() {
  const now = Date.now();
  const db = database();
  const [machines, waitlist] = await db.batch([
    db.prepare("SELECT id, ends_at, updated_at, version FROM machine_state"),
    db.prepare("SELECT id, location_id, nickname, created_at FROM waitlist_entry WHERE created_at > ?1").bind(now - WAITLIST_TTL_MS),
  ]);
  return { ...stateSnapshot(machines.results as StateRow[], now), waitlist: waitlistSnapshot(waitlist.results as WaitlistRow[], now) };
}

export async function snapshotResponse(extra: Record<string, unknown> = {}) {
  return Response.json({ ...(await readSnapshot()), ...extra }, { headers: { "Cache-Control": "no-store" } });
}

export function errorResponse(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}
