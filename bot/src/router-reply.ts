import { readFileSync } from "node:fs";

export function routerReplyChannelId(environment: NodeJS.ProcessEnv = process.env): string | null {
  if (environment.CONCIERGE_RUNTIME_PROFILE !== "sandbox") return "D0BMWUJ3RD5";
  if (environment.CONCIERGE_SANDBOX_ROUTER_REPLY_MODE !== "1") return null;
  const fixtures = JSON.parse(readFileSync(environment.CONCIERGE_SANDBOX_FIXTURES!, "utf8"));
  if (fixtures.lane_id !== `lane-${environment.CONCIERGE_SANDBOX_LANE}`
      || !/^D[A-Z0-9]+$/.test(fixtures.dm_channel_id)) {
    throw new Error("Router reply mode requires the claimed sandbox lane's exact DM fixture.");
  }
  return fixtures.dm_channel_id;
}
