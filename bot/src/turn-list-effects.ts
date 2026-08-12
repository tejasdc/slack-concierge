import { existsSync, readFileSync } from "node:fs";
import { errorFields, log } from "./log";
import {
  appendListItem,
  completeListItem,
  refreshListMirror,
} from "./lists";
import type { ChannelRow } from "./state";

export interface TurnListEffectsOptions {
  signingSecret: string;
  botUserId: string;
  reportFailure(client: any, channel: ChannelRow, error: unknown): Promise<void>;
  reportPaidPlanError(client: any, channel: ChannelRow, error: unknown): Promise<void>;
}

export class TurnListEffects {
  constructor(private readonly options: TurnListEffectsOptions) {}

  async loadContext(client: any, channel: ChannelRow, user: string) {
    try {
      const path = await this.refresh(client, channel, user);
      if (path && existsSync(path)) return readFileSync(path, "utf-8");
    } catch (error) {
      await this.options.reportFailure(client, channel, error);
    }
    return "Slack List context is not currently readable.";
  }

  async apply(input: {
    client: any;
    channel: ChannelRow;
    user: string;
    adds: string[];
    completes: string[];
  }) {
    if (input.adds.length === 0 && input.completes.length === 0) return;
    try {
      for (const text of input.adds) {
        await appendListItem({
          client: input.client,
          channel: input.channel,
          text,
          source: "agent",
          user: input.user,
          identitySecret: this.options.signingSecret,
          identityOwnerId: this.options.botUserId,
        });
      }
      for (const itemId of input.completes) {
        await completeListItem({
          client: input.client,
          channel: input.channel,
          itemId,
          user: input.user,
          identitySecret: this.options.signingSecret,
          identityOwnerId: this.options.botUserId,
        });
      }
      await this.refresh(input.client, input.channel, input.user);
      log("info", "agent_list_ops_applied", {
        channel: input.channel.slack_channel_id,
        add_count: input.adds.length,
        complete_count: input.completes.length,
      });
    } catch (error) {
      await this.options.reportFailure(input.client, input.channel, error);
      log("error", "agent_list_ops_failed", {
        channel: input.channel.slack_channel_id,
        add_count: input.adds.length,
        complete_count: input.completes.length,
        ...errorFields(error),
      });
    }
  }

  private refresh(client: any, channel: ChannelRow, user: string) {
    return refreshListMirror({
      client,
      channel,
      user,
      onPaidPlanError: (error) => this.options.reportPaidPlanError(client, channel, error),
      identitySecret: this.options.signingSecret,
      identityOwnerId: this.options.botUserId,
    });
  }
}
