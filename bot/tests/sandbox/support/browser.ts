import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { LaneFixtureIdentities } from "../../../scripts/sandbox-provision";
import type { SandboxEvidenceWriter, ScreenshotEvidence } from "./evidence";

export const APPROVED_SANDBOX_WORKSPACE_DOMAIN = "concierge--sandbox.enterprise.slack.com";
const SLACK_WEB_DOMAIN = "app.slack.com";

export type BrowserCaptureRequest = {
  lane_id: string;
  workspace_domain: string;
  browser_namespace: string;
  browser_profile_path: string;
  phase: "input" | "running" | "terminal";
  permalink: string;
  channel_id: string;
  message_ts: string;
  thread_ts: string;
  assertions: string[];
  required_text?: string[];
};

export interface SandboxBrowser {
  capture(request: BrowserCaptureRequest, evidence: SandboxEvidenceWriter): Promise<ScreenshotEvidence>;
}

export type AgentBrowserCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export interface AgentBrowserCommandRunner {
  run(arguments_: string[], timeoutMs?: number): Promise<AgentBrowserCommandResult>;
}

export class SandboxBrowserDriverError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function browserCommandEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of [
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "XDG_RUNTIME_DIR", "DISPLAY",
    "WAYLAND_DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "LANG", "LC_ALL",
  ]) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  return environment;
}

export class BunAgentBrowserCommandRunner implements AgentBrowserCommandRunner {
  constructor(private readonly executable = "agent-browser") {}

  async run(arguments_: string[], timeoutMs = 35_000): Promise<AgentBrowserCommandResult> {
    const subprocess = Bun.spawn([this.executable, ...arguments_], {
      env: browserCommandEnvironment(),
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      subprocess.kill();
    }, timeoutMs);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
      subprocess.exited,
    ]).finally(() => clearTimeout(timeout));
    if (timedOut) {
      throw new SandboxBrowserDriverError("agent_browser_timeout", "agent-browser exceeded the bounded command timeout");
    }
    return { exitCode, stdout, stderr };
  }
}

export class SandboxBrowserBoundaryUnavailable extends Error {
  readonly code = "browser_boundary_unverified";

  constructor(laneId: string, profilePath: string) {
    super(
      `Slack web authentication is not available for ${laneId} at ${profilePath}; `
      + "complete the explicit one-time sandbox login boundary before collecting visual evidence.",
    );
  }
}

export class UnverifiedSandboxBrowser implements SandboxBrowser {
  constructor(private readonly fixtures: LaneFixtureIdentities) {}

  async capture(): Promise<ScreenshotEvidence> {
    throw new SandboxBrowserBoundaryUnavailable(this.fixtures.lane_id, this.fixtures.browser.profile_path);
  }
}

function expectedPermalinkPath(channelId: string, messageTs: string): string {
  return `/archives/${channelId}/p${messageTs.replace(".", "")}`;
}

function webClientMessageUrl(request: BrowserCaptureRequest, fixtures: LaneFixtureIdentities): string {
  const url = new URL(`https://${fixtures.browser.canonical_workspace_domain}`);
  url.pathname = `/messages/${request.channel_id}/p${request.message_ts.replace(".", "")}`;
  url.searchParams.set("thread_ts", request.thread_ts);
  url.searchParams.set("skip_today", "1");
  return url.toString();
}

function exactSandboxPermalink(request: BrowserCaptureRequest, fixtures: LaneFixtureIdentities): URL {
  let permalink: URL;
  try {
    permalink = new URL(request.permalink);
  } catch {
    throw new SandboxBrowserDriverError("invalid_browser_permalink", "Browser permalink is not a URL");
  }
  const expectedPath = expectedPermalinkPath(request.channel_id, request.message_ts);
  const searchKeys = [...permalink.searchParams.keys()];
  const validThreadQuery = searchKeys.length === 2
    && new Set(searchKeys).size === 2
    && permalink.searchParams.get("thread_ts") === request.thread_ts
    && permalink.searchParams.get("cid") === request.channel_id;
  const validSearch = !permalink.search
    ? request.message_ts === request.thread_ts
    : validThreadQuery;
  if (request.workspace_domain !== APPROVED_SANDBOX_WORKSPACE_DOMAIN
      || permalink.protocol !== "https:"
      || permalink.hostname !== fixtures.browser.canonical_workspace_domain
      || permalink.port || permalink.username || permalink.password
      || permalink.pathname !== expectedPath || !validSearch || permalink.hash) {
    throw new SandboxBrowserDriverError(
      "invalid_browser_permalink",
      "Browser navigation is restricted to the exact approved sandbox message permalink",
    );
  }
  return permalink;
}

function assertPrivateLaneProfile(path: string, laneId: string): string {
  if (!isAbsolute(path) || basename(path) !== laneId) {
    throw new SandboxBrowserDriverError("unsafe_browser_profile", "Browser profile is not the selected lane profile");
  }
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new SandboxBrowserBoundaryUnavailable(laneId, path);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0
      || realpathSync(path) !== resolve(path)) {
    throw new SandboxBrowserDriverError("unsafe_browser_profile", "Browser profile must be an owner-only real directory");
  }
  return path;
}

function parseCommandJson(result: AgentBrowserCommandResult, operation: string): Record<string, unknown> {
  if (result.exitCode !== 0) {
    throw new SandboxBrowserDriverError("agent_browser_command_failed", `agent-browser ${operation} failed with exit ${result.exitCode}`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new SandboxBrowserDriverError("agent_browser_invalid_output", `agent-browser ${operation} returned invalid JSON`);
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)
      || ("success" in payload && payload.success !== true)) {
    throw new SandboxBrowserDriverError("agent_browser_command_failed", `agent-browser ${operation} did not report success`);
  }
  return payload as Record<string, unknown>;
}

function commandData(payload: Record<string, unknown>): unknown {
  return "data" in payload ? payload.data : payload;
}

function commandString(payload: Record<string, unknown>, field: string, operation: string): string {
  const data = commandData(payload);
  if (typeof data === "string") return data;
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    const value = (data as Record<string, unknown>)[field];
    if (typeof value === "string" && value) return value;
  }
  throw new SandboxBrowserDriverError("agent_browser_invalid_output", `agent-browser ${operation} omitted ${field}`);
}

function commandObject(payload: Record<string, unknown>, operation: string): Record<string, unknown> {
  const data = commandData(payload);
  const result = typeof data === "object" && data !== null && !Array.isArray(data) && "result" in data
    ? (data as Record<string, unknown>).result
    : data;
  if (typeof result === "string") {
    try {
      const parsed = JSON.parse(result);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      throw new SandboxBrowserDriverError("agent_browser_invalid_output", `agent-browser ${operation} returned invalid object JSON`);
    }
  }
  if (typeof result === "object" && result !== null && !Array.isArray(result)) return result as Record<string, unknown>;
  throw new SandboxBrowserDriverError("agent_browser_invalid_output", `agent-browser ${operation} omitted its result object`);
}

function expectedConversationName(fixtures: LaneFixtureIdentities, channelId: string): string | null {
  for (const channel of Object.values(fixtures.channels)) {
    if (channel.id === channelId) return channel.name;
  }
  return null;
}

function assertObservedSlackRoute(observedUrl: string, request: BrowserCaptureRequest, fixtures: LaneFixtureIdentities): void {
  let observed: URL;
  try {
    observed = new URL(observedUrl);
  } catch {
    throw new SandboxBrowserDriverError("browser_identity_mismatch", "Slack browser returned an invalid current URL");
  }
  if (observed.protocol !== "https:" || observed.username || observed.password || observed.port) {
    throw new SandboxBrowserDriverError("browser_identity_mismatch", "Slack browser left the authenticated HTTPS route");
  }
  const expectedPath = expectedPermalinkPath(request.channel_id, request.message_ts);
  if (observed.hostname === fixtures.browser.canonical_workspace_domain && observed.pathname === expectedPath) return;
  const segments = observed.pathname.split("/").filter(Boolean);
  if (observed.hostname !== SLACK_WEB_DOMAIN || segments[0] !== "client"
      || segments[1] !== fixtures.browser.client_workspace_id || segments[2] !== request.channel_id) {
    throw new SandboxBrowserDriverError(
      "browser_identity_mismatch",
      "Slack browser is unauthenticated or opened another workspace/channel",
    );
  }
}

function assertAccessibleTarget(
  snapshot: string,
  request: BrowserCaptureRequest,
  fixtures: LaneFixtureIdentities,
): void {
  const conversationName = expectedConversationName(fixtures, request.channel_id);
  const expectedPath = expectedPermalinkPath(request.channel_id, request.message_ts);
  if (!snapshot.includes(expectedPath)) {
    throw new SandboxBrowserDriverError("browser_render_mismatch", "Accessibility snapshot omitted the exact target permalink");
  }
  if (conversationName && !snapshot.toLowerCase().includes(conversationName.toLowerCase())) {
    throw new SandboxBrowserDriverError("browser_identity_mismatch", "Accessibility snapshot omitted the expected lane channel name");
  }
}

function geometryScript(request: BrowserCaptureRequest, fixtures: LaneFixtureIdentities): string {
  const expectedPath = expectedPermalinkPath(request.channel_id, request.message_ts);
  const channelName = expectedConversationName(fixtures, request.channel_id);
  const requiredText = request.required_text || [];
  return `(() => {
    const expectedPath = ${JSON.stringify(expectedPath)};
    const expectedTs = ${JSON.stringify(request.message_ts)};
    const expectedChannelName = ${JSON.stringify(channelName)};
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    const anchor = anchors.find((candidate) => {
      try { return new URL(candidate.href).pathname === expectedPath; } catch { return false; }
    });
    if (!anchor) return { ok: false, reason: 'target_permalink_missing' };
    const message = anchor.closest('[data-qa="message_container"], [data-qa="virtual-list-item"], .c-virtual_list__item, [role="listitem"]') || anchor.parentElement;
    if (!message) return { ok: false, reason: 'target_container_missing' };
    const rect = message.getBoundingClientRect();
    const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0
      && rect.top < window.innerHeight && rect.left < window.innerWidth;
    const headerCandidates = Array.from(document.querySelectorAll('[data-qa="channel_name"], [data-qa="channel-header-title"], h1, h2'));
    const header = expectedChannelName
      ? headerCandidates.find((candidate) => (candidate.textContent || '').toLowerCase().includes(expectedChannelName.toLowerCase()))
      : null;
    const headerRect = header ? header.getBoundingClientRect() : null;
    const visibleText = document.body.innerText || '';
    return {
      ok: true,
      target: {
        permalink_path: expectedPath,
        message_ts: expectedTs,
        visible,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      },
      channel_header: headerRect ? {
        name: expectedChannelName,
        visible: headerRect.width > 0 && headerRect.height > 0,
        x: headerRect.x,
        y: headerRect.y,
        width: headerRect.width,
        height: headerRect.height,
      } : null,
      required_text: ${JSON.stringify(requiredText)}.map((text) => ({ text, count: text ? visibleText.split(text).length - 1 : 0 })),
      viewport: { width: window.innerWidth, height: window.innerHeight, device_pixel_ratio: window.devicePixelRatio },
      document: { title: document.title, location: window.location.href },
    };
  })()`;
}

function assertTargetGeometry(
  geometry: Record<string, unknown>,
  request: BrowserCaptureRequest,
  fixtures: LaneFixtureIdentities,
): void {
  const target = typeof geometry.target === "object" && geometry.target !== null && !Array.isArray(geometry.target)
    ? geometry.target as Record<string, unknown>
    : null;
  if (geometry.ok !== true || !target || target.visible !== true
      || target.permalink_path !== expectedPermalinkPath(request.channel_id, request.message_ts)
      || target.message_ts !== request.message_ts
      || typeof target.width !== "number" || target.width <= 0
      || typeof target.height !== "number" || target.height <= 0) {
    throw new SandboxBrowserDriverError("browser_render_mismatch", "Target Slack message has no verified visible geometry");
  }
  const expectedName = expectedConversationName(fixtures, request.channel_id);
  if (expectedName) {
    const header = typeof geometry.channel_header === "object" && geometry.channel_header !== null
      && !Array.isArray(geometry.channel_header) ? geometry.channel_header as Record<string, unknown> : null;
    if (!header || header.name !== expectedName || header.visible !== true) {
      throw new SandboxBrowserDriverError("browser_identity_mismatch", "Expected lane channel header has no visible geometry");
    }
  }
  const renderedText = Array.isArray(geometry.required_text) ? geometry.required_text : [];
  for (const requiredText of request.required_text || []) {
    const rendered = renderedText.find((value) => typeof value === "object" && value !== null
      && !Array.isArray(value) && (value as Record<string, unknown>).text === requiredText) as Record<string, unknown> | undefined;
    if (!requiredText || !rendered || typeof rendered.count !== "number" || rendered.count < 1) {
      throw new SandboxBrowserDriverError("browser_render_mismatch", "Rendered Slack view omitted required case text");
    }
  }
}

export function assertBrowserRequestMatchesLane(
  request: BrowserCaptureRequest,
  fixtures: LaneFixtureIdentities,
): void {
  if (request.lane_id !== fixtures.lane_id
      || request.browser_namespace !== fixtures.browser.namespace
      || request.browser_profile_path !== fixtures.browser.profile_path) {
    throw new SandboxBrowserDriverError("browser_identity_mismatch", "Browser request does not belong to the selected sandbox lane");
  }
  const knownChannels = new Set([
    fixtures.dm_channel_id,
    fixtures.channels.core.id,
    fixtures.channels.project.id,
    fixtures.channels.capture.id,
  ]);
  if (!knownChannels.has(request.channel_id)) {
    throw new SandboxBrowserDriverError("browser_identity_mismatch", "Browser request targets a channel outside the selected lane");
  }
  exactSandboxPermalink(request, fixtures);
}

export class AgentBrowserSlackDriver implements SandboxBrowser {
  constructor(
    private readonly fixtures: LaneFixtureIdentities,
    private readonly runner: AgentBrowserCommandRunner = new BunAgentBrowserCommandRunner(),
  ) {}

  private commandArguments(request: BrowserCaptureRequest, command: string[], headed = false): string[] {
    assertPrivateLaneProfile(request.browser_profile_path, request.lane_id);
    return [
      ...command,
      "--session", request.browser_namespace,
      "--profile", request.browser_profile_path,
      ...(headed ? ["--headed"] : []),
      "--json",
    ];
  }

  private async command(request: BrowserCaptureRequest, operation: string, arguments_: string[]): Promise<Record<string, unknown>> {
    const result = await this.runner.run(this.commandArguments(request, arguments_));
    return parseCommandJson(result, operation);
  }

  async openLoginBoundary(workspaceDomain = APPROVED_SANDBOX_WORKSPACE_DOMAIN): Promise<{
    lane_id: string;
    client_workspace_id: string;
    browser_namespace: string;
    browser_profile_path: string;
    workspace_url: string;
    authentication_verified: false;
  }> {
    if (workspaceDomain !== APPROVED_SANDBOX_WORKSPACE_DOMAIN) {
      throw new SandboxBrowserDriverError("browser_identity_mismatch", "Browser login is restricted to the approved sandbox workspace");
    }
    const request: BrowserCaptureRequest = {
      lane_id: this.fixtures.lane_id,
      workspace_domain: workspaceDomain,
      browser_namespace: this.fixtures.browser.namespace,
      browser_profile_path: this.fixtures.browser.profile_path,
      phase: "input",
      permalink: `https://${workspaceDomain}/archives/${this.fixtures.channels.core.id}/p0000000000000000`,
      channel_id: this.fixtures.channels.core.id,
      message_ts: "0000000000.000000",
      thread_ts: "0000000000.000000",
      assertions: [],
    };
    const workspaceUrl = `https://${workspaceDomain}/`;
    const result = await this.runner.run(this.commandArguments(request, ["open", workspaceUrl], true));
    parseCommandJson(result, "login boundary open");
    return {
      lane_id: this.fixtures.lane_id,
      client_workspace_id: this.fixtures.browser.client_workspace_id,
      browser_namespace: this.fixtures.browser.namespace,
      browser_profile_path: this.fixtures.browser.profile_path,
      workspace_url: workspaceUrl,
      authentication_verified: false,
    };
  }

  async capture(request: BrowserCaptureRequest, evidence: SandboxEvidenceWriter): Promise<ScreenshotEvidence> {
    assertBrowserRequestMatchesLane(request, this.fixtures);
    if (evidence.laneId !== request.lane_id) {
      throw new SandboxBrowserDriverError("browser_identity_mismatch", "Evidence writer belongs to another sandbox lane");
    }
    const browserDirectory = evidence.ensureDirectory("browser");
    const screenshotPath = join(browserDirectory, `${request.phase}.png`);
    const accessibilityPath = join(browserDirectory, `${request.phase}-accessibility.json`);
    const geometryPath = join(browserDirectory, `${request.phase}-geometry.json`);
    const accessibilityName = `${request.phase}-accessibility.json`;
    const geometryName = `${request.phase}-geometry.json`;
    if ([screenshotPath, accessibilityPath, geometryPath].some(existsSync)) {
      throw new SandboxBrowserDriverError("browser_evidence_exists", "Browser evidence already exists for this run and phase");
    }

    await this.command(request, "web client handoff", ["open", webClientMessageUrl(request, this.fixtures)]);
    const expectedPath = expectedPermalinkPath(request.channel_id, request.message_ts);
    const waitExpression = `() => {
      const anchor = Array.from(document.querySelectorAll('a[href]')).find((candidate) => {
        try { return new URL(candidate.href).pathname === ${JSON.stringify(expectedPath)}; } catch { return false; }
      });
      const message = anchor && (anchor.closest('[data-qa="message_container"], [data-qa="virtual-list-item"], .c-virtual_list__item, [role="listitem"]') || anchor.parentElement);
      if (!message) return false;
      const rect = message.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0
        && rect.top < window.innerHeight && rect.left < window.innerWidth;
      const text = document.body.innerText || '';
      return visible && ${JSON.stringify(request.required_text || [])}.every((required) => text.includes(required));
    }`;
    await this.command(request, "wait for target", ["wait", "--fn", waitExpression]);
    const centerExpression = `(() => {
      const anchor = Array.from(document.querySelectorAll('a[href]')).find((candidate) => {
        try { return new URL(candidate.href).pathname === ${JSON.stringify(expectedPath)}; } catch { return false; }
      });
      const message = anchor && (anchor.closest('[data-qa="message_container"], [data-qa="virtual-list-item"], .c-virtual_list__item, [role="listitem"]') || anchor.parentElement);
      if (!message) return false;
      message.scrollIntoView({ block: 'center', inline: 'nearest' });
      return true;
    })()`;
    await this.command(request, "center target", ["eval", centerExpression]);

    const observedUrl = commandString(await this.command(request, "current URL", ["get", "url"]), "url", "current URL");
    assertObservedSlackRoute(observedUrl, request, this.fixtures);
    const title = commandString(await this.command(request, "page title", ["get", "title"]), "title", "page title");
    const snapshotPayload = await this.command(request, "accessibility snapshot", ["snapshot", "--compact", "--urls"]);
    const snapshot = commandString(snapshotPayload, "snapshot", "accessibility snapshot");
    assertAccessibleTarget(snapshot, request, this.fixtures);

    const geometry = commandObject(await this.command(request, "target geometry", ["eval", geometryScript(request, this.fixtures)]),
      "target geometry");
    assertTargetGeometry(geometry, request, this.fixtures);
    const screenshotResult = await this.runner.run(this.commandArguments(request, ["screenshot", screenshotPath]));
    parseCommandJson(screenshotResult, "screenshot");

    evidence.writeJsonIn("browser", accessibilityName, {
      schema_version: 1,
      lane_id: request.lane_id,
      browser_namespace: request.browser_namespace,
      browser_profile_path: request.browser_profile_path,
      app_id: this.fixtures.app_id,
      team_id: this.fixtures.team_id,
      client_workspace_id: this.fixtures.browser.client_workspace_id,
      canonical_workspace_domain: this.fixtures.browser.canonical_workspace_domain,
      channel_id: request.channel_id,
      message_ts: request.message_ts,
      thread_ts: request.thread_ts,
      observed_url: observedUrl,
      title,
      snapshot,
    });
    evidence.writeJsonIn("browser", geometryName, {
      schema_version: 1,
      lane_id: request.lane_id,
      browser_namespace: request.browser_namespace,
      browser_profile_path: request.browser_profile_path,
      app_id: this.fixtures.app_id,
      team_id: this.fixtures.team_id,
      client_workspace_id: this.fixtures.browser.client_workspace_id,
      canonical_workspace_domain: this.fixtures.browser.canonical_workspace_domain,
      channel_id: request.channel_id,
      message_ts: request.message_ts,
      thread_ts: request.thread_ts,
      observed_url: observedUrl,
      geometry,
    });
    return evidence.verifyScreenshot({
      phase: request.phase,
      permalink: request.permalink,
      client_workspace_id: this.fixtures.browser.client_workspace_id,
      canonical_workspace_domain: this.fixtures.browser.canonical_workspace_domain,
      channel_id: request.channel_id,
      message_ts: request.message_ts,
      screenshot_path: screenshotPath,
      accessibility_path: accessibilityPath,
      geometry_path: geometryPath,
    });
  }
}
