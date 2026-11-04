export function queueEnabled(env: { QUEUE_ENABLED?: string }) {
  return env.QUEUE_ENABLED === "true";
}
