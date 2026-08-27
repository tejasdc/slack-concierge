import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  SandboxProvisioningError,
  applySandboxManifests,
  atomicWritePrivate,
  importLaneSecrets,
  importWorkspaceCredential,
  loadLaneFixtureIdentities,
  loadLaneFixtures,
  loadSandboxTopology,
  manifestContractDigest,
  manifestDigest,
  manifestForLane,
  provisionLaneFixtures,
  provisioningPlan,
  rotateWorkspaceCredential,
  sandboxProvisioningPaths,
  type SlackRequester,
} from "../../scripts/sandbox-provision";

const roots: string[] = [];
const projectRoot = resolve(import.meta.dir, "../../..");
const topology = loadSandboxTopology(join(projectRoot, "config/sandbox-lanes.json"));
const sourceManifest = JSON.parse(readFileSync(join(projectRoot, "slack-app-manifest.json"), "utf8"));

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "sandbox-provisioning-"));
  roots.push(root);
  return root;
}

function privateJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function workspaceCredential(expiresAtMs = Date.now() + 60 * 60_000) {
  return {
    schema_version: 1,
    team_id: "TSANDBOX1",
    user_id: "UINSTALLER1",
    access_token: "xoxe.xoxp-access-private",
    refresh_token: "xoxe-refresh-private",
    expires_at_ms: expiresAtMs,
  };
}

function laneSecrets(appId = "AAPP1") {
  return {
    schema_version: 1,
    app_id: appId,
    team_id: "TSANDBOX1",
    app_token: "xapp-private",
    bot_token: "xoxb-private",
    user_token: "xoxp-private",
    signing_secret: "a".repeat(32),
    client_id: "12345.67890",
    client_secret: "b".repeat(24),
  };
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("sandbox manifest topology", () => {
  test("defines four distinct native lanes while preserving one manifest contract", () => {
    expect(topology.workspace_domain).toBe("concierge--sandbox.enterprise.slack.com");
    expect(topology.lanes.map((lane) => lane.id)).toEqual(["lane-1", "lane-2", "lane-3", "lane-4"]);
    const contract = manifestContractDigest(sourceManifest);
    expect(topology.lanes.every((lane) => manifestContractDigest(manifestForLane(sourceManifest, lane)) === contract)).toBe(true);
    expect(new Set(topology.lanes.map((lane) => manifestDigest(manifestForLane(sourceManifest, lane)))).size).toBe(4);
  });

  test("treats observed Slack export defaults and shortcut ordering as provider normalization", () => {
    const expected = manifestForLane(sourceManifest, topology.lanes[0]);
    const exported = structuredClone(expected);
    const features = exported.features as Record<string, unknown>;
    const agentView = features.agent_view as Record<string, unknown>;
    agentView.suggested_prompts = [];
    features.shortcuts = [...(features.shortcuts as unknown[])].reverse();
    (exported.oauth_config as Record<string, unknown>).pkce_enabled = false;
    (exported.settings as Record<string, unknown>).is_mcp_enabled = false;

    expect(manifestDigest(exported)).toBe(manifestDigest(expected));
    expect(manifestContractDigest(exported)).toBe(manifestContractDigest(expected));

    (exported.settings as Record<string, unknown>).socket_mode_enabled = false;
    expect(manifestContractDigest(exported)).not.toBe(manifestContractDigest(expected));
  });

  test("plans controller-aligned config, fixture, browser, and run roots without secrets", () => {
    const plan = provisioningPlan(topology, sourceManifest);
    expect(plan.configuration_credential_path).toBe("/etc/concierge/sandbox/workspace-configuration.json");
    expect(plan.lanes[0]).toMatchObject({
      slack_config_path: "/etc/concierge/sandbox/lanes/lane-1/slack.toml",
      fixtures_path: "/etc/concierge/sandbox/lanes/lane-1/fixtures.json",
      provisioned_identity_path: "/etc/concierge/sandbox/lanes/lane-1/identity.json",
      browser_profile_path: "/root/.local/state/concierge-sandbox/browser/lane-1",
    });
    expect(JSON.stringify(plan)).not.toMatch(/xox|signing_secret|client_secret/);
  });
});

describe("sandbox secret handling", () => {
  test("imports owner-only credentials atomically and rejects a permissive source", () => {
    const root = scratch();
    const source = join(root, "workspace-source.json");
    const destination = join(root, "config", "workspace-configuration.json");
    privateJson(source, workspaceCredential());
    expect(importWorkspaceCredential(source, destination).team_id).toBe("TSANDBOX1");
    expect(statSync(destination).mode & 0o777).toBe(0o600);

    chmodSync(source, 0o644);
    expect(() => importWorkspaceCredential(source, join(root, "other.json"))).toThrow(SandboxProvisioningError);
  });

  test("rotates the single-use refresh token atomically without logging or changing identity", async () => {
    const root = scratch();
    const credentialPath = join(root, "workspace-configuration.json");
    atomicWritePrivate(credentialPath, `${JSON.stringify(workspaceCredential(Date.now() - 1))}\n`);
    const requester: SlackRequester = async (_url, init) => {
      expect(String(init?.body)).toContain("xoxe-refresh-private");
      return response({
        ok: true,
        token: "xoxe.xoxp-new-private",
        refresh_token: "xoxe-new-refresh-private",
        team_id: "TSANDBOX1",
        user_id: "UINSTALLER1",
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
    };
    const rotated = await rotateWorkspaceCredential(credentialPath, requester);
    expect(rotated).toMatchObject({ team_id: "TSANDBOX1", user_id: "UINSTALLER1" });
    expect(readFileSync(credentialPath, "utf8")).toContain("xoxe-new-refresh-private");
    expect(statSync(credentialPath).mode & 0o777).toBe(0o600);
  });

  test("does not overwrite a credential when rotation returns another workspace", async () => {
    const root = scratch();
    const credentialPath = join(root, "workspace-configuration.json");
    const original = `${JSON.stringify(workspaceCredential(Date.now() - 1))}\n`;
    atomicWritePrivate(credentialPath, original);
    await expect(rotateWorkspaceCredential(credentialPath, async () => response({
      ok: true,
      token: "xoxe.xoxp-new-private",
      refresh_token: "xoxe-new-refresh-private",
      team_id: "TWRONG1",
      user_id: "UINSTALLER1",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }))).rejects.toThrow("changed workspace/user identity");
    expect(readFileSync(credentialPath, "utf8")).toBe(original);
  });
});

describe("manifest-backed lane provisioning", () => {
  test("creates four lanes, stores returned secrets privately, and reports attended installation boundaries", async () => {
    const root = scratch();
    const configRoot = join(root, "config");
    const credentialSource = join(root, "credential.json");
    privateJson(credentialSource, workspaceCredential());
    importWorkspaceCredential(credentialSource, sandboxProvisioningPaths(configRoot).workspaceCredential);
    let createIndex = 0;
    const manifests = new Map<string, unknown>();
    const requester: SlackRequester = async (url, init) => {
      const method = String(url).split("/").pop();
      const body = JSON.parse(String(init?.body));
      if (method === "apps.manifest.validate") return response({ ok: true });
      if (method === "apps.manifest.create") {
        createIndex += 1;
        const appId = `AAPP${createIndex}`;
        manifests.set(appId, JSON.parse(body.manifest));
        return response({
          ok: true,
          app_id: appId,
          credentials: {
            client_id: `${createIndex}2345.${createIndex}7890`,
            client_secret: String(createIndex).repeat(24),
            signing_secret: "a".repeat(32),
          },
          oauth_authorize_url: `https://slack.com/oauth/v2/authorize?client_id=${createIndex}`,
        });
      }
      if (method === "apps.manifest.export") return response({ ok: true, manifest: manifests.get(body.app_id) });
      throw new Error(`unexpected method ${method}`);
    };

    const result = await applySandboxManifests({ topology, sourceManifest, configRoot, requester });
    expect(result.lanes).toHaveLength(4);
    expect(result.lanes.every((lane) => lane.status === "authorization_required")).toBe(true);
    expect(result.lanes.every((lane) => lane.attended_actions.length === 3)).toBe(true);
    expect(result.lanes[0]?.app_settings_url).toBe("https://api.slack.com/apps/AAPP1/general");
    expect(result.lanes[0]?.oauth_authorize_url).toContain("slack.com/oauth/v2/authorize");
    expect(JSON.stringify(result)).not.toMatch(/xox|client_secret|signing_secret/);
    for (const lane of topology.lanes) {
      const credentialPath = sandboxProvisioningPaths(configRoot).laneCreateCredentials(lane.id);
      expect(statSync(credentialPath).mode & 0o777).toBe(0o600);
    }

    const verified = await applySandboxManifests({ topology, sourceManifest, configRoot, requester });
    expect(verified.lanes.map((lane) => lane.app_id)).toEqual(["AAPP1", "AAPP2", "AAPP3", "AAPP4"]);
  });

  test("parks an unknown create outcome and refuses to create the lane again", async () => {
    const root = scratch();
    const configRoot = join(root, "config");
    const credentialSource = join(root, "credential.json");
    privateJson(credentialSource, workspaceCredential());
    importWorkspaceCredential(credentialSource, sandboxProvisioningPaths(configRoot).workspaceCredential);
    let createCalls = 0;
    const requester: SlackRequester = async (url) => {
      if (String(url).endsWith("apps.manifest.validate")) return response({ ok: true });
      createCalls += 1;
      throw new Error("connection dropped");
    };
    await expect(applySandboxManifests({ topology, sourceManifest, configRoot, requester }))
      .rejects.toMatchObject({ code: "apps.manifest.create_outcome_unknown" });
    await expect(applySandboxManifests({ topology, sourceManifest, configRoot, requester }))
      .rejects.toMatchObject({ code: "ambiguous_app_creation" });
    expect(createCalls).toBe(1);
  });

  test("parks a malformed create success with its valid app id before refusing a duplicate", async () => {
    const root = scratch();
    const configRoot = join(root, "config");
    const paths = sandboxProvisioningPaths(configRoot);
    const credentialSource = join(root, "credential.json");
    privateJson(credentialSource, workspaceCredential());
    importWorkspaceCredential(credentialSource, paths.workspaceCredential);
    let createCalls = 0;
    const requester: SlackRequester = async (url) => {
      if (String(url).endsWith("apps.manifest.validate")) return response({ ok: true });
      createCalls += 1;
      return response({
        ok: true,
        app_id: "AORPHAN1",
        credentials: { client_id: "malformed" },
        oauth_authorize_url: "https://slack.com/oauth/v2/authorize?client_id=1",
      });
    };
    await expect(applySandboxManifests({ topology, sourceManifest, configRoot, requester }))
      .rejects.toMatchObject({ code: "invalid_configuration" });
    const registry = JSON.parse(readFileSync(paths.registry, "utf8"));
    expect(registry.lanes[0]).toMatchObject({ app_id: "AORPHAN1", status: "ambiguous" });
    await expect(applySandboxManifests({ topology, sourceManifest, configRoot, requester }))
      .rejects.toMatchObject({ code: "ambiguous_app_creation" });
    expect(createCalls).toBe(1);
  });
});

describe("lane installation and fixture identities", () => {
  test("imports complete secrets, creates fixed fixtures, and writes controller identity separately", async () => {
    const root = scratch();
    const configRoot = join(root, "config");
    const stateRoot = join(root, "state");
    const browserRoot = join(root, "browser");
    const credentialSource = join(root, "credential.json");
    privateJson(credentialSource, workspaceCredential());
    importWorkspaceCredential(credentialSource, sandboxProvisioningPaths(configRoot).workspaceCredential);
    let created = false;
    let createdManifest: unknown;
    const manifestRequester: SlackRequester = async (url, init) => {
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith("apps.manifest.validate")) return response({ ok: true });
      if (String(url).endsWith("apps.manifest.create") && !created) {
        created = true;
        createdManifest = JSON.parse(body.manifest);
        return response({ ok: true, app_id: "AAPP1", credentials: {
          client_id: "12345.67890", client_secret: "b".repeat(24), signing_secret: "a".repeat(32),
        }, oauth_authorize_url: "https://slack.com/oauth/v2/authorize?client_id=1" });
      }
      if (String(url).endsWith("apps.manifest.export")) return response({ ok: true, manifest: createdManifest });
      throw new Error("stop after first lane");
    };
    await expect(applySandboxManifests({ topology, sourceManifest, configRoot, requester: manifestRequester })).rejects.toThrow();

    const registryPath = sandboxProvisioningPaths(configRoot).registry;
    const registryBeforeImport = JSON.parse(readFileSync(registryPath, "utf8"));
    registryBeforeImport.lanes[0].permissions_updated = true;
    atomicWritePrivate(registryPath, `${JSON.stringify(registryBeforeImport)}\n`);

    const secretSource = join(root, "lane-secrets.json");
    privateJson(secretSource, { ...laneSecrets(), client_secret: "c".repeat(24) });
    expect(() => importLaneSecrets(topology.lanes[0]!, secretSource, configRoot))
      .toThrow("does not match lane-1 create credentials");
    privateJson(secretSource, laneSecrets());
    importLaneSecrets(topology.lanes[0]!, secretSource, configRoot);
    expect(statSync(sandboxProvisioningPaths(configRoot).laneSlackConfig("lane-1")).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(registryPath, "utf8")).lanes[0].permissions_updated).toBe(false);

    const channelIds = ["CCORE1", "CPROJECT1", "CCAPTURE1"];
    let channelIndex = 0;
    const joinedChannels: string[] = [];
    const invitedChannels: string[] = [];
    const fixtureRequester: SlackRequester = async (url, init) => {
      const method = String(url).split("/").pop();
      const authorization = new Headers(init?.headers).get("authorization");
      const body = JSON.parse(String(init?.body || "{}"));
      if (method === "auth.test" && authorization === "Bearer xoxb-private") {
        return response({
          ok: true,
          team_id: "TSANDBOX1",
          enterprise_id: "EENTERPRISE1",
          url: "https://sandbox-workspace.slack.com/",
          user_id: "UBOT1",
          bot_id: "BBOT1",
        });
      }
      if (method === "auth.test" && authorization === "Bearer xoxp-private") {
        return response({
          ok: true,
          team_id: "TSANDBOX1",
          enterprise_id: "EENTERPRISE1",
          url: "https://sandbox-workspace.slack.com/",
          user_id: "UINSTALLER1",
        });
      }
      if (method === "apps.connections.open") return response({ ok: true, url: "wss://redacted.invalid" });
      if (method === "conversations.list") return response({ ok: true, channels: [], response_metadata: { next_cursor: "" } });
      if (method === "conversations.create") return response({ ok: true, channel: { id: channelIds[channelIndex++] } });
      if (method === "conversations.join") {
        joinedChannels.push(body.channel);
        return response({ ok: true, channel: { id: body.channel, is_member: true } });
      }
      if (method === "conversations.invite") {
        expect(body.users).toBe("UINSTALLER1");
        invitedChannels.push(body.channel);
        if (body.channel === "CCORE1") return response({ ok: false, error: "already_in_channel" });
        return response({ ok: true, channel: { id: body.channel } });
      }
      if (method === "conversations.open") return response({ ok: true, channel: { id: "DDM1" } });
      throw new Error(`unexpected method ${method}`);
    };
    const identities = await provisionLaneFixtures({
      lane: topology.lanes[0]!, configRoot, stateRoot, browserRoot, requester: fixtureRequester,
    });
    expect(identities).toMatchObject({ lane_id: "lane-1", app_id: "AAPP1", dm_channel_id: "DDM1",
      channels: { core: { id: "CCORE1" }, project: { id: "CPROJECT1" }, capture: { id: "CCAPTURE1" } } });
    expect(joinedChannels).toEqual(channelIds);
    expect(invitedChannels).toEqual(channelIds);
    expect(loadLaneFixtureIdentities(
      sandboxProvisioningPaths(configRoot).laneIdentity("lane-1"),
      sandboxProvisioningPaths(configRoot).laneFixtures("lane-1"),
    )).toEqual(identities);
    const controllerIdentity = JSON.parse(readFileSync(sandboxProvisioningPaths(configRoot).laneIdentity("lane-1"), "utf8"));
    expect(controllerIdentity).toMatchObject({
      schema_version: 1,
      lane_id: "lane-1",
      team_id: "TSANDBOX1",
      app_id: "AAPP1",
      bot_user_id: "UBOT1",
      bot_id: "BBOT1",
    });
    expect(controllerIdentity.manifest_digest).toHaveLength(64);
    const persistedFixtures = JSON.parse(readFileSync(sandboxProvisioningPaths(configRoot).laneFixtures("lane-1"), "utf8"));
    expect(persistedFixtures).toEqual({
      schema_version: 1,
      lane_id: "lane-1",
      installer_user_id: "UINSTALLER1",
      dm_channel_id: "DDM1",
      channels: {
        core: { id: "CCORE1", name: "concierge-lane-1-core" },
        project: { id: "CPROJECT1", name: "concierge-lane-1-project" },
        capture: { id: "CCAPTURE1", name: "concierge-lane-1-capture" },
      },
      browser: {
        namespace: "concierge-sandbox-lane-1",
        profile_path: join(browserRoot, "lane-1"),
        client_workspace_id: "EENTERPRISE1",
        canonical_workspace_domain: "sandbox-workspace.slack.com",
      },
    });
    atomicWritePrivate(
      sandboxProvisioningPaths(configRoot).laneFixtures("lane-1"),
      `${JSON.stringify({
        ...persistedFixtures,
        browser: { ...persistedFixtures.browser, client_workspace_id: "TSANDBOX1" },
      })}\n`,
    );
    expect(() => loadLaneFixtures(sandboxProvisioningPaths(configRoot).laneFixtures("lane-1")))
      .toThrow("Invalid browser client workspace ID");
    atomicWritePrivate(
      sandboxProvisioningPaths(configRoot).laneFixtures("lane-1"),
      `${JSON.stringify({ ...persistedFixtures, app_id: "AAPP1" })}\n`,
    );
    expect(() => loadLaneFixtures(sandboxProvisioningPaths(configRoot).laneFixtures("lane-1")))
      .toThrow("Invalid lane fixtures keys");
    expect(statSync(identities.browser.profile_path).mode & 0o777).toBe(0o700);
  });
});
