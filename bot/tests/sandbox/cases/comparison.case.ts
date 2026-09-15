import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { LaneFixtureIdentities } from "../../../scripts/sandbox-provision";
import type { LiveTypedTurnAdapter } from "../adapters/live-typed-turn";
import {
  assertBrowserRequestMatchesLane,
  type SandboxInteractiveBrowser,
} from "../support/browser";
import type { SandboxEvidenceWriter } from "../support/evidence";
import type { TypedTurnPostReceipt } from "./typed-turn.case";

type ComparisonObservation = {
  request_id: string;
  source_message_ts: string;
  target_provider: string;
  target_model: string | null;
  comparison_thread_ts: string;
  status: string;
  turn_id: number;
  turn_status: string;
  delivery_status: string;
  provider_id: string;
  user_text: string;
  outbound_text: string;
  unreplayable_attachment_count: number;
  files_json: string;
};

function blockText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(blockText).join("\n");
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  return [blockText(record.text), blockText(record.elements)]
    .filter(Boolean).join("\n");
}

function comparisonPermalink(lane: LaneFixtureIdentities, channelId: string, messageTs: string): string {
  return `https://${lane.browser.canonical_workspace_domain}/archives/${channelId}/p${messageTs.replace(".", "")}`;
}

async function waitForComparison(
  database: Database,
  sourceSessionId: number,
  sourceMessageTs: string,
): Promise<ComparisonObservation> {
  const deadline = Date.now() + 10 * 60_000;
  let last: ComparisonObservation | null = null;
  while (Date.now() <= deadline) {
    last = database.query(`
      SELECT request.request_id, request.source_message_ts, request.target_provider, request.target_model,
             request.comparison_thread_ts, request.status, turn.id AS turn_id,
             turn.status AS turn_status, turn.delivery_status, session.provider_id,
             turn.user_text, turn.outbound_text, turn.unreplayable_attachment_count,
             claim.files_json
      FROM comparison_requests request
      LEFT JOIN turns turn ON turn.id=request.turn_id
      LEFT JOIN sessions session ON session.id=turn.session_id
      LEFT JOIN slack_user_input_claims claim
        ON claim.slack_channel_id=session.slack_channel_id
       AND claim.slack_user_msg_ts=turn.slack_user_msg_ts
      WHERE request.source_session_id=? AND request.source_message_ts=?
      ORDER BY request.created_at DESC
      LIMIT 1
    `).get(sourceSessionId, sourceMessageTs) as ComparisonObservation | null;
    if (last?.status === "done" && last.turn_status === "done" && last.delivery_status === "delivered") return last;
    if (last && ["error", "cancelled"].includes(last.status)) {
      throw new Error(`Comparison ${last.request_id} ended ${last.status}/${last.turn_status}`);
    }
    await Bun.sleep(250);
  }
  throw new Error(`Comparison through ${sourceMessageTs} did not complete: ${JSON.stringify(last)}`);
}

export async function runComparisonCase(options: {
  lane: LaneFixtureIdentities;
  workspaceDomain: string;
  runId: string;
  adapter: LiveTypedTurnAdapter;
  browser: SandboxInteractiveBrowser;
  evidence: SandboxEvidenceWriter;
}) {
  const { lane, adapter, browser, evidence } = options;
  const marker = `SANDBOX_COMPARISON_${randomUUID().replaceAll("-", "").toUpperCase()}`;
  const attachmentMarker = `ATTACHMENT_${marker}`;
  const attachmentPath = evidence.path("comparison-brief.txt");
  writeFileSync(attachmentPath, `${attachmentMarker}\nThe comparison provider must inspect this complete file.\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  let database: Database | null = null;
  try {
    const destinationSetup = await adapter.postUserMessage({
      lane,
      channel_id: lane.channels.core.id,
      client_message_id: randomUUID(),
      text: `@cx-fast Return TL;DR: ${marker} destination ready.`,
    });
    await adapter.waitForRouterSearchTurn(destinationSetup);
    const routerSource = await adapter.postUserMessage({
      lane,
      channel_id: lane.dm_channel_id,
      client_message_id: randomUUID(),
      text: `@cx-fast Return TL;DR: ${marker} router source ready.`,
    });
    await adapter.waitForRouterSearchTurn(routerSource);
    const routed = await adapter.submitRoutedRequest({
      source: { channel_id: routerSource.channel_id, message_ts: routerSource.message_ts },
      action_id: `${marker}_SOURCE`,
      destination: { channel_id: lane.channels.core.id },
      task: `@cx-fast Read the attached brief and begin your final with TL;DR: ${marker} source attachment accepted.`,
      defer: false,
      depends_on: [],
      files: [attachmentPath],
    });
    const sourceReceipt: TypedTurnPostReceipt = {
      channel_id: routed.channel,
      message_ts: routed.ts,
      thread_ts: routed.thread_ts || routed.ts,
      permalink: routed.permalink,
      client_message_id: routed.request_id,
      delivery: "confirmed",
    };
    const sourceTurn = await adapter.waitForRouterSearchTurn(sourceReceipt);
    if (sourceTurn.provider_id !== "codex" || routed.file_ids.length !== 1) {
      throw new Error("File-backed source thread did not bind one Slack file to a Codex session");
    }
    const slackFileId = routed.file_ids[0];
    const followUpReceipt = await adapter.postUserMessage({
      lane,
      channel_id: sourceReceipt.channel_id,
      thread_ts: sourceReceipt.thread_ts,
      client_message_id: randomUUID(),
      text: `Continue this thread and begin the final with TL;DR: ${marker} inner user message accepted.`,
    });
    const followUpTurn = await adapter.waitForRouterSearchTurn(followUpReceipt);
    if (followUpTurn.session_id !== sourceTurn.session_id || followUpTurn.provider_id !== "codex") {
      throw new Error("Inner user message did not continue the exact source Codex session");
    }

    database = new Database(adapter.routerSearchContext().state_database, { readonly: true });
    const progress = database.query(`
      SELECT message_ts
      FROM agent_progress_messages
      WHERE turn_id=? AND message_ts IS NOT NULL
      ORDER BY page_number
      LIMIT 1
    `).get(followUpTurn.turn_id) as { message_ts: string } | null;
    if (!progress?.message_ts) throw new Error("Source turn exposed no agent-authored progress message for comparison");

    const commonBrowserRequest = {
      lane_id: lane.lane_id,
      workspace_domain: options.workspaceDomain,
      browser_namespace: lane.browser.namespace,
      browser_profile_path: lane.browser.profile_path,
      phase: "input" as const,
      channel_id: sourceReceipt.channel_id,
      thread_ts: sourceReceipt.thread_ts,
      shortcut_name: "Compare w another agent",
      assertions: ["the exact inner message offers and directly invokes the comparison shortcut without a picker"],
    };
    const userShortcut = await browser.invokeMessageShortcut({
      ...commonBrowserRequest,
      permalink: followUpReceipt.permalink,
      message_ts: followUpReceipt.message_ts,
      evidence_name: "comparison-user-shortcut.json",
    }, evidence);
    const userComparison = await waitForComparison(database, sourceTurn.session_id, followUpReceipt.message_ts);

    const agentMessageTs = progress.message_ts;
    const agentShortcut = await browser.invokeMessageShortcut({
      ...commonBrowserRequest,
      permalink: `${comparisonPermalink(lane, sourceReceipt.channel_id, agentMessageTs)}?thread_ts=${sourceReceipt.thread_ts}&cid=${sourceReceipt.channel_id}`,
      message_ts: agentMessageTs,
      evidence_name: "comparison-agent-shortcut.json",
    }, evidence);
    const agentComparison = await waitForComparison(database, sourceTurn.session_id, agentMessageTs);

    for (const comparison of [userComparison, agentComparison]) {
      const files = JSON.parse(comparison.files_json) as Array<{ id?: string; name?: string }>;
      if (comparison.target_provider !== "claude-code"
          || comparison.provider_id !== "claude-code"
          || comparison.unreplayable_attachment_count !== 1
          || files.length !== 1
          || files[0]?.id !== slackFileId
          || !comparison.user_text.includes(slackFileId)
          || !comparison.outbound_text.includes(marker)
          || !comparison.outbound_text.includes(attachmentMarker)) {
        throw new Error("Comparison did not preserve automatic counterpart selection and exact attachment replay");
      }
      const anchor = await adapter.readRoutedSlackMessage(sourceReceipt.channel_id, comparison.comparison_thread_ts);
      const visible = `${String(anchor.text || "")}\n${blockText(anchor.blocks)}`;
      if (anchor.user !== lane.bot_user_id
          || !visible.includes("A/B comparison: codex → claude-code")
          || !visible.includes("Re-supplying 1 original file attachment")
          || !visible.includes("Original attachments re-supplied")
          || !visible.includes(slackFileId)
          || !visible.includes("comparison-brief.txt")) {
        throw new Error("Comparison root did not visibly disclose its provider and re-supplied attachment");
      }
    }

    await adapter.waitForRunSettled();
    const sourceBrowserRequest = {
      lane_id: lane.lane_id,
      workspace_domain: options.workspaceDomain,
      browser_namespace: lane.browser.namespace,
      browser_profile_path: lane.browser.profile_path,
      phase: "terminal" as const,
      capture_name: "comparison-source-thread",
      permalink: followUpReceipt.permalink,
      channel_id: sourceReceipt.channel_id,
      message_ts: followUpReceipt.message_ts,
      thread_ts: sourceReceipt.thread_ts,
      required_text: [marker],
      forbidden_text: ["Comparison started", "Compare agent", "Run comparison"],
      assertions: [
        "the inner user message remains visible without a comparison picker",
        "no redundant ephemeral success confirmation appears in the source thread",
      ],
    };
    assertBrowserRequestMatchesLane(sourceBrowserRequest, lane);
    const sourceBrowser = evidence.verifyScreenshot(await browser.capture(sourceBrowserRequest, evidence));
    const comparisonBrowsers = [];
    for (const [role, comparison] of [["user", userComparison], ["agent", agentComparison]] as const) {
      const request = {
        lane_id: lane.lane_id,
        workspace_domain: options.workspaceDomain,
        browser_namespace: lane.browser.namespace,
        browser_profile_path: lane.browser.profile_path,
        phase: "terminal" as const,
        capture_name: `comparison-${role}-result`,
        permalink: comparisonPermalink(lane, sourceReceipt.channel_id, comparison.comparison_thread_ts),
        channel_id: sourceReceipt.channel_id,
        message_ts: comparison.comparison_thread_ts,
        thread_ts: comparison.comparison_thread_ts,
        required_text: [marker, "Re-supplying 1 original file attachment", "comparison-brief.txt"],
        forbidden_text: ["Comparison started", "Compare agent", "Run comparison"],
        assertions: [
          `the ${role}-message comparison visibly selected Claude Code without a picker`,
          "the root visibly identifies the exact original attachment and the provider result confirms reading its contents",
        ],
      };
      assertBrowserRequestMatchesLane(request, lane);
      comparisonBrowsers.push(evidence.verifyScreenshot(await browser.capture(request, evidence)));
    }
    const result = {
      case_id: "comparison",
      status: "passed",
      lane_id: lane.lane_id,
      run_id: options.runId,
      source: adapter.runSourceEvidence(),
      marker,
      attachment_marker: attachmentMarker,
      slack_file_id: slackFileId,
      source_receipt: sourceReceipt,
      follow_up_receipt: followUpReceipt,
      agent_message_ts: agentMessageTs,
      user_shortcut: userShortcut,
      agent_shortcut: agentShortcut,
      user_comparison: userComparison,
      agent_comparison: agentComparison,
      browser: { source: sourceBrowser, comparisons: comparisonBrowsers },
    };
    evidence.writeJson("comparison-result.json", result);
    return result;
  } finally {
    database?.close();
  }
}
