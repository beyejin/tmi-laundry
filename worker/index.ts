import handler from "vinext/server/fetch-handler";
import { processPushOutbox } from "../lib/push";

export default {
  fetch: handler.fetch,
  async scheduled(_controller: ScheduledController, env: Cloudflare.Env, ctx: ExecutionContext) {
    ctx.waitUntil(Promise.all([
      processPushOutbox(env.DB, env),
      env.DB.batch([
        env.DB.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").bind(Date.now()),
        env.DB.prepare("DELETE FROM oauth_states WHERE expires_at <= ?").bind(Date.now()),
      ]),
    ]).catch((error) => {
      console.error("Scheduled queue processing failed", error instanceof Error ? error.message : "unknown error");
      throw error;
    }));
  },
} satisfies ExportedHandler<Cloudflare.Env>;
