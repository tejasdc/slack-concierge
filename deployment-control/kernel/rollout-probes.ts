import { createHash } from "node:crypto";
import {
  chmodSync,
  chownSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  defaultReleaseManagerEnvironment,
  ImmutableReleaseManager,
  releaseBuilderSystemdProperties,
  releaseFileSetDigest,
} from "./releases";
import { ActivationGateManager } from "./activation-gates";

export const ROLLOUT_PROBES = {
  application_containment: "preactivation",
  control_plane_health: "preactivation",
  provider_session_continuity: "preactivation",
  security_negative_matrix: "preactivation",
  synthetic_incident: "canary",
  canary_recovery: "recovery",
  last_known_good_health: "recovery",
  contained_rollback: "recovery",
  contained_rollback_alert: "recovery",
  production_health: "production",
} as const;

export type RolloutProbeName = keyof typeof ROLLOUT_PROBES;
export type RolloutProbePhase = typeof ROLLOUT_PROBES[RolloutProbeName];

export interface RolloutProbeContext {
  rollout: any;
  gates: any;
  identityDigest: string;
  lastKnownGood: any;
  incident: any;
  incidentAttempt: any;
  repairRun: any;
  reviewRun: any;
  reviewRuns: any[];
  learning: any;
  canaryActivation: any;
  canaryHandoff: any;
  productionActivation: any;
  productionHandoff: any;
  incidentNotifications: any[];
}

export interface RolloutProbeEnvironment {
  repositoryRoot: string;
  runtimeRoot: string;
  releaseRoot: string;
  applicationStatePath: string;
  captureStatePath: string;
  slackConfigPath: string;
  systemctlBin: string;
  systemdRunBin: string;
  runuserBin: string;
  curlBin: string;
  bunBin: string;
  serviceName: string;
  run?: (command: string[], options?: { env?: Record<string, string> }) => {
    exitCode: number;
    stdout: string;
    stderr: string;
  };
  wait?: (milliseconds: number) => Promise<void>;
}

export class RolloutProbeAmbiguousError extends Error {}

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function parsedProperties(value: string) {
  return Object.fromEntries(value.trim().split("\n").filter(Boolean).map((line) => {
    const separator = line.indexOf("=");
    return separator < 0 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function normalizedTree(path: string, mode: number) {
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) normalizedTree(join(path, entry), mode);
    chownSync(path, 0, 0);
    chmodSync(path, mode);
    return;
  }
  chownSync(path, 0, 0);
  chmodSync(path, mode === 0o700 ? 0o600 : ((stat.mode & 0o111) ? 0o555 : 0o444));
}

export function defaultRolloutProbeEnvironment(repositoryRoot: string): RolloutProbeEnvironment {
  const releaseEnvironment = defaultReleaseManagerEnvironment(repositoryRoot);
  return {
    repositoryRoot,
    runtimeRoot: releaseEnvironment.installRoot,
    releaseRoot: releaseEnvironment.releaseRoot,
    applicationStatePath: process.env.CONCIERGE_APPLICATION_STATE_PATH || "/var/lib/concierge-bot/state/state.db",
    captureStatePath: process.env.CONCIERGE_CAPTURE_STATE_PATH || "/var/lib/concierge-capture/state.db",
    slackConfigPath: process.env.CONCIERGE_SLACK_CONFIG_PATH || "/root/.config/concierge/slack.toml",
    systemctlBin: releaseEnvironment.systemctlBin,
    systemdRunBin: releaseEnvironment.systemdRunBin,
    runuserBin: "/usr/sbin/runuser",
    curlBin: "/usr/bin/curl",
    bunBin: join(releaseEnvironment.installRoot, "bun"),
    serviceName: releaseEnvironment.serviceName.replace(/\.service$/, ""),
  };
}

export class RolloutProbeExporter {
  constructor(
    readonly environment: RolloutProbeEnvironment,
    readonly releaseManager = new ImmutableReleaseManager({
      ...defaultReleaseManagerEnvironment(environment.repositoryRoot),
      releaseRoot: environment.releaseRoot,
      installRoot: environment.runtimeRoot,
      systemctlBin: environment.systemctlBin,
      systemdRunBin: environment.systemdRunBin,
      serviceName: environment.serviceName,
    }),
    readonly activationGateManager = new ActivationGateManager({
      applicationStatePath: environment.applicationStatePath,
      captureStatePath: environment.captureStatePath,
    }),
  ) {}

  private execute(command: string[], options: { env?: Record<string, string> } = {}) {
    if (this.environment.run) return this.environment.run(command, options);
    const result = Bun.spawnSync({
      cmd: command,
      env: options.env || process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  }

  private checked(command: string[], options: { env?: Record<string, string> } = {}) {
    const result = this.execute(command, options);
    if (result.exitCode !== 0) {
      throw new Error(`${basename(command[0])} ${command[1] || ""} failed: ${result.stderr.trim().slice(0, 1_000) || "unknown error"}`);
    }
    return result.stdout.trim();
  }

  private service(unit: string) {
    const properties = parsedProperties(this.checked([
      this.environment.systemctlBin,
      "show",
      unit,
      "--property=ActiveState,SubState,MainPID,InvocationID,User,Group,SupplementaryGroups,DynamicUser,StateDirectory,StateDirectoryMode,RuntimeDirectory,RuntimeDirectoryMode,Environment,LoadCredential,PrivateNetwork,PrivateUsers,PrivateTmp,PrivateDevices,IPAddressDeny,IPAddressAllow,ProtectSystem,ProtectHome,ProtectProc,ProcSubset,NoNewPrivileges,RestrictAddressFamilies,CapabilityBoundingSet,TemporaryFileSystem,BindPaths,BindReadOnlyPaths,InaccessiblePaths,ReadOnlyPaths,ReadWritePaths,Listen,ListenStream,SocketUser,SocketGroup,SocketMode,DirectoryMode,Accept,RemoveOnStop",
    ]));
    return {
      unit,
      ...properties,
      main_pid: Number(properties.MainPID || "0"),
      active: properties.ActiveState === "active",
    };
  }

  private heldGates(context: RolloutProbeContext) {
    requireCondition(context.gates?.status === "held", "The rollout does not own both held admission gates.");
    return {
      status: context.gates.status,
      held_at: context.gates.held_at,
      deployment_held_at: context.gates.deployment_held_at,
      capture_held_at: context.gates.capture_held_at,
    };
  }

  private applicationContainment(context: RolloutProbeContext) {
    const application = this.service(`${this.environment.serviceName}.service`);
    requireCondition(application.active && application.main_pid > 1 && application.InvocationID,
      "The contained application is not active with an invocation identity.");
    requireCondition(application.User === "concierge-bot" && application.Group === "concierge-bot",
      "The production application is not running as concierge-bot.");
    requireCondition(application.Environment?.includes("CONCIERGE_STATE_DIR=/var/lib/concierge-bot/state")
      && application.Environment.includes("CONCIERGE_PROVIDER_BROKER_ENABLED=1")
      && application.Environment.includes("CONCIERGE_PROVIDER_PROJECTS_PATH=/var/lib/concierge-bot/provider-projects.json"),
    "The production application environment is not bound to contained state and provider brokers.");
    requireCondition(application.LoadCredential?.includes("slack_config")
      && application.LoadCredential.includes("capture_queue"),
    "The contained application does not receive both credentials through systemd.");
    const database = lstatSync(this.environment.applicationStatePath);
    const botUid = Number(this.checked(["/usr/bin/id", "-u", "concierge-bot"]));
    requireCondition(database.isFile() && database.uid === botUid && (database.mode & 0o077) === 0,
      "The contained application database ownership or mode is invalid.");
    const registryPath = join(dirname(dirname(this.environment.applicationStatePath)), "provider-projects.json");
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    requireCondition(registry.schema_version === 1 && Array.isArray(registry.projects) && registry.projects.length > 0,
      "The provider project registry is invalid or empty.");
    const sockets = registry.projects.map((project: any) => {
      requireCondition(typeof project.id === "string" && typeof project.socket_path === "string",
        "The provider project registry contains an invalid entry.");
      const observed = this.service(`concierge-provider-broker@${project.id}.socket`);
      requireCondition(observed.active, `Provider broker socket ${project.id} is not active.`);
      return { project_id: project.id, socket_path: project.socket_path, invocation_id: observed.InvocationID || null };
    });
    return {
      principal: { user: application.User, group: application.Group, uid: botUid },
      service_invocation_id: application.InvocationID,
      database: { path: this.environment.applicationStatePath, uid: database.uid, mode: database.mode & 0o777 },
      credential_names: ["slack_config", "capture_queue"],
      provider_brokers: sockets,
      admission: this.heldGates(context),
    };
  }

  private controlPlaneHealth(context: RolloutProbeContext) {
    const units = [
      "concierge-deployment-kernel.service",
      "concierge-deployment-provider-adapter.service",
      context.canaryHandoff?.incumbent_unit || "concierge-deployment-coordinator.service",
      context.rollout.owner_unit,
    ];
    const observed = units.map((unit) => this.service(unit));
    for (const unit of observed) {
      requireCondition(unit.active && unit.main_pid > 1 && unit.InvocationID,
        `Protected unit ${unit.unit} is not active with an invocation identity.`);
    }
    requireCondition(context.rollout.identity_digest === context.identityDigest,
      "The live closed identity differs from the rollout authority.");
    return {
      identity_digest: context.identityDigest,
      units: observed.map((unit) => ({
        unit: unit.unit,
        invocation_id: unit.InvocationID,
        main_pid: unit.main_pid,
        user: unit.User || "root",
      })),
      admission: this.heldGates(context),
    };
  }

  private providerContinuity(context: RolloutProbeContext) {
    const result = this.execute([
      this.environment.runuserBin,
      "-u",
      "concierge-bot",
      "--",
      "/usr/bin/env",
      `CONCIERGE_STATE_DIR=${dirname(this.environment.applicationStatePath)}`,
      "CONCIERGE_PROVIDER_PROJECTS_PATH=/var/lib/concierge-bot/provider-projects.json",
      this.environment.bunBin,
      join(this.environment.runtimeRoot, "provider/current/continuity.js"),
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`Provider continuity failed as concierge-bot: ${result.stderr.trim().slice(0, 2_000)}`);
    }
    const evidence = JSON.parse(result.stdout.trim());
    requireCondition(evidence.status === "passed", "Provider continuity did not return passed evidence.");
    return { principal: "concierge-bot", ...evidence, admission: this.heldGates(context) };
  }

  private securityNegativeMatrix(context: RolloutProbeContext) {
    const sensitiveTargets = [
      "/root/.codex/auth.json",
      "/root/.local/state/concierge-deployment/control.db",
      this.environment.slackConfigPath,
      this.environment.captureStatePath,
      join(this.environment.releaseRoot, "current/manifest.json"),
    ];
    for (const path of sensitiveTargets) requireCondition(existsSync(path), `Negative-test target ${path} does not exist.`);
    const registryPath = join(dirname(dirname(this.environment.applicationStatePath)), "provider-projects.json");
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    requireCondition(registry.schema_version === 1 && Array.isArray(registry.projects) && registry.projects.length > 0,
      "The provider project registry is unavailable to the security matrix.");
    const principals: Array<{
      user: string;
      unit: string;
      network: "address-deny" | "private" | "allowed";
      allowedTarget?: string;
      projectId?: string;
      transient?: boolean;
    }> = [
      { user: "concierge-repair", unit: "concierge-deployment-repair@.service", network: "address-deny", allowedTarget: "/run/concierge-deployment/repair.sock" },
      { user: "concierge-review", unit: "concierge-deployment-review@.service", network: "address-deny", allowedTarget: "/run/concierge-deployment/review.sock" },
      { user: "concierge-rollout", unit: "concierge-deployment-rollout@.service", network: "private", allowedTarget: "/run/concierge-deployment/rollout.sock" },
      { user: "concierge-deploy", unit: "concierge-deployment-coordinator@.service", network: "private", allowedTarget: "/run/concierge-deployment/coordinator.sock" },
      { user: "concierge-bot", unit: `${this.environment.serviceName}.service`, network: "allowed", allowedTarget: "/run/concierge-deployment/bot.sock" },
      { user: "root", unit: "concierge-deployment-provider-adapter.service", network: "allowed", allowedTarget: "/run/concierge-provider-adapter/adapter.sock" },
      { user: "concierge-builder", unit: "transient-release-builder", network: "private", transient: true },
    ];
    for (const project of registry.projects as Array<{ id: string; stable_path: string }>) {
      requireCondition(typeof project.id === "string" && typeof project.stable_path === "string",
        "The provider project registry contains invalid security authority.");
      principals.push(
        { user: `cb-${project.id}`, unit: `concierge-provider-broker@${project.id}.service`, network: "private", projectId: project.id,
          allowedTarget: `/run/concierge-provider/${project.id}/worker.sock` },
        { user: `cp-${project.id}`, unit: `concierge-provider-worker@${project.id}.service`, network: "allowed", projectId: project.id },
      );
    }
    const hostReachability = this.execute([this.environment.curlBin, "--fail", "--silent", "--show-error", "--max-time", "8", "https://github.com"]);
    requireCondition(hostReachability.exitCode === 0, "The root control probe could not prove GitHub was otherwise reachable.");
    const denials: Array<Record<string, unknown>> = [];
    const builderProbeOutput = mkdtempSync("/tmp/concierge-rollout-builder-");
    let caseIndex = 0;
    for (const principal of principals) {
      const transientProfile = principal.transient
        ? releaseBuilderSystemdProperties({
          source: join(this.environment.runtimeRoot, "kernel/current"),
          outputParent: builderProbeOutput,
          installRoot: this.environment.runtimeRoot,
          builderUser: principal.user,
          builderGroup: principal.user,
        })
        : [];
      const unit = principal.transient
        ? parsedProperties(transientProfile.map((property) => property.slice("--property=".length)).join("\n"))
        : this.service(principal.unit);
      requireCondition(unit.NoNewPrivileges === "yes" && unit.ProtectSystem === "strict",
        `Installed authority ${principal.unit} lacks its required systemd security profile.`);
      const deniedAccess = sensitiveTargets.map((target) => ({ target, mode: "-r" }))
        .filter(({ target }) => principal.user !== "concierge-bot"
          || (target !== this.environment.applicationStatePath
            && target !== join(this.environment.releaseRoot, "current/manifest.json")))
        .filter(({ target }) => !(principal.unit === "concierge-deployment-provider-adapter.service"
          && target === "/root/.codex/auth.json"));
      if (principal.user === "concierge-bot") {
        deniedAccess.push({ target: join(this.environment.releaseRoot, "current/manifest.json"), mode: "-w" });
      }
      for (const socket of ["bot", "coordinator", "runner", "repair", "review", "rollout", "operator"]) {
        const target = `/run/concierge-deployment/${socket}.sock`;
        if (target !== principal.allowedTarget) deniedAccess.push({ target, mode: "-w" });
      }
      if (principal.projectId) {
        for (const project of registry.projects as Array<{ id: string; stable_path: string }>) {
          if (project.id === principal.projectId) continue;
          deniedAccess.push(
            { target: `/run/concierge-provider/${project.id}/worker.sock`, mode: "-e" },
            { target: project.stable_path, mode: "-e" },
          );
        }
      }
      for (const access of deniedAccess) {
        caseIndex += 1;
        const properties = [
          "--property=Type=exec",
          `--property=User=${principal.user}`,
          "--property=NoNewPrivileges=yes",
          "--property=PrivateTmp=yes",
          "--property=PrivateDevices=yes",
          `--property=ProtectSystem=${unit.ProtectSystem || "strict"}`,
          `--property=ProtectHome=${unit.ProtectHome || "yes"}`,
          `--property=ProtectProc=${unit.ProtectProc || "invisible"}`,
          `--property=ProcSubset=${unit.ProcSubset || "pid"}`,
          "--property=CapabilityBoundingSet=",
        ];
        for (const property of ["Group", "SupplementaryGroups", "DynamicUser", "PrivateUsers",
          "PrivateNetwork", "RestrictAddressFamilies", "IPAddressDeny", "IPAddressAllow",
          "TemporaryFileSystem", "BindPaths", "BindReadOnlyPaths", "ReadOnlyPaths", "ReadWritePaths"]) {
          if ((unit as any)[property]) properties.push(`--property=${property}=${(unit as any)[property]}`);
        }
        if (unit.InaccessiblePaths) properties.push(`--property=InaccessiblePaths=${unit.InaccessiblePaths}`);
        const result = this.execute([
          this.environment.systemdRunBin,
          "--wait", "--pipe", "--collect",
          "--unit", `concierge-rollout-denial-${context.rollout.id.slice(0, 8)}-${caseIndex}`,
          ...properties,
          "/usr/bin/test", access.mode, access.target,
        ]);
        requireCondition(result.exitCode !== 0, `${principal.user} unexpectedly passed ${access.mode} ${access.target}.`);
        denials.push({
          principal: principal.user,
          resource: access.target,
          operation: access.mode === "-r" ? "read" : access.mode === "-w" ? "write" : "visibility",
          outcome: "denied",
          installed_unit: principal.unit,
        });
      }
      if (principal.network === "allowed") continue;
      const unitName = `concierge-rollout-negative-${context.rollout.id.slice(0, 8)}-${principal.user.replace("concierge-", "")}`;
      const properties = [
        "--property=Type=exec",
        `--property=User=${principal.user}`,
        "--property=NoNewPrivileges=yes",
        "--property=PrivateTmp=yes",
        "--property=PrivateDevices=yes",
        "--property=ProtectSystem=strict",
        "--property=ProtectHome=yes",
        "--property=CapabilityBoundingSet=",
      ];
      if (principal.network === "private") {
        properties.push("--property=PrivateNetwork=yes", "--property=RestrictAddressFamilies=AF_UNIX");
      } else {
        properties.push("--property=IPAddressDeny=any", "--property=IPAddressAllow=localhost");
      }
      const network = this.execute([
        this.environment.systemdRunBin,
        "--wait", "--pipe", "--collect", "--unit", unitName,
        ...properties,
        this.environment.curlBin,
        "--fail", "--silent", "--show-error", "--max-time", "5", "https://github.com",
      ]);
      requireCondition(network.exitCode !== 0, `${principal.user} unexpectedly reached GitHub from its isolated systemd profile.`);
      denials.push({ principal: principal.user, resource: "https://github.com", outcome: "denied", isolation: principal.network });
    }
    rmSync(builderProbeOutput, { recursive: true, force: true });
    return {
      host_control_reachability: "passed",
      denial_count: denials.length,
      denials,
      admission: this.heldGates(context),
    };
  }

  private syntheticIncident(context: RolloutProbeContext) {
    requireCondition(context.incident?.rollout_id === context.rollout.id && context.incident.status === "learning",
      "The synthetic incident has not reached durable learning.");
    requireCondition(context.repairRun?.provider_session_uuid && context.repairRun?.integrated_commit,
      "The synthetic repair lacks one bound provider session or integrated commit.");
    requireCondition(context.reviewRun?.status === "ship" && context.reviewRun?.provider_session_uuid,
      "The synthetic repair lacks one independent SHIP session.");
    requireCondition(context.repairRun.provider_launch_attempted === 1 && context.repairRun.status === "completed",
      "The synthetic repair does not have exactly one admitted, bound, terminal repair turn.");
    const admittedReviews = context.reviewRuns.filter((review) => review.provider_launch_attempted === 1);
    requireCondition(admittedReviews.length === 1
      && admittedReviews[0].id === context.reviewRun.id
      && admittedReviews[0].status === "ship"
      && admittedReviews[0].provider_session_uuid,
    "The synthetic repair does not have exactly one admitted, bound, terminal review turn.");
    requireCondition(context.repairRun.provider_session_uuid !== context.reviewRun.provider_session_uuid,
      "The synthetic repair and independent review used the same provider session.");
    requireCondition(context.incidentAttempt?.status === "succeeded"
      && context.incidentAttempt.deployed_commit === context.repairRun.integrated_commit,
    "The synthetic repair was not forward-deployed successfully.");
    requireCondition(context.learning?.status === "recorded", "The synthetic repair has no durable learning record.");
    requireCondition(context.lastKnownGood?.git_commit === context.repairRun.integrated_commit,
      "The synthetic repair was not promoted as the exact last known good.");
    const fixture = readFileSync(join(this.environment.repositoryRoot, "bot/src/deployment-repair/synthetic-fixture.ts"), "utf8");
    requireCondition(fixture.includes('rolloutSyntheticFixtureStatus = "healthy"'),
      "The synthetic fixture does not contain the reviewed healthy correction.");
    return {
      incident_id: context.incident.id,
      repair_session_uuid: context.repairRun.provider_session_uuid,
      review_session_uuid: context.reviewRun.provider_session_uuid,
      integrated_commit: context.repairRun.integrated_commit,
      deployed_commit: context.incidentAttempt.deployed_commit,
      service_invocation_id: context.incidentAttempt.service_invocation_id,
      learning_id: context.learning.id,
      last_known_good_release_id: context.lastKnownGood.id,
      fixture_status: "healthy",
      admission: this.heldGates(context),
    };
  }

  private canaryRecovery(context: RolloutProbeContext) {
    requireCondition(context.canaryActivation?.status === "revoked",
      "The canary activation is not permanently revoked.");
    requireCondition(context.canaryHandoff?.status === "recovered",
      "The coordinator incumbent has not been durably recovered.");
    const incumbent = context.canaryHandoff.incumbent_was_active
      ? this.service(context.canaryHandoff.incumbent_unit)
      : null;
    if (incumbent) {
      requireCondition(incumbent.active && incumbent.InvocationID === context.canaryHandoff.recovery_invocation_id,
        "The recovered coordinator invocation does not match durable evidence.");
    }
    return {
      canary_generation_id: context.canaryActivation.id,
      revoked_at: context.canaryActivation.revoked_at,
      coordinator_status: context.canaryHandoff.status,
      incumbent_unit: context.canaryHandoff.incumbent_unit,
      recovery_invocation_id: context.canaryHandoff.recovery_invocation_id,
      admission: this.heldGates(context),
    };
  }

  private functionalHealth(context: RolloutProbeContext, admission = this.heldGates(context)) {
    requireCondition(context.lastKnownGood?.artifact_path, "There is no recorded last-known-good artifact.");
    const current = realpathSync(join(this.environment.releaseRoot, "current"));
    requireCondition(current === realpathSync(context.lastKnownGood.artifact_path),
      "The stable release pointer does not match the recorded last known good.");
    const manifest = JSON.parse(readFileSync(join(current, "manifest.json"), "utf8"));
    requireCondition(manifest.git_commit === context.lastKnownGood.git_commit,
      "The current release manifest does not match the recorded last-known-good commit.");
    const capture = this.execute([
      this.environment.bunBin,
      join(this.environment.repositoryRoot, "bot/scripts/capture-healthcheck.ts"),
    ]);
    requireCondition(capture.exitCode === 0, `Capture health failed: ${capture.stderr.trim().slice(0, 1_000)}`);
    const service = this.execute([
      this.environment.bunBin,
      join(this.environment.repositoryRoot, "bot/scripts/healthcheck.ts"),
    ], { env: {
      ...process.env,
      CONCIERGE_CONFIG_PATH: this.environment.slackConfigPath,
      CONCIERGE_PROVIDER_BROKER_ENABLED: "1",
      CONCIERGE_PROVIDER_PROJECTS_PATH: "/var/lib/concierge-bot/provider-projects.json",
      CONCIERGE_STATE_DIR: dirname(this.environment.applicationStatePath),
    } });
    requireCondition(service.exitCode === 0, `Application health failed: ${service.stderr.trim().slice(0, 1_000)}`);
    const application = this.service(`${this.environment.serviceName}.service`);
    requireCondition(application.active && application.InvocationID,
      "The application is not active after functional health.");
    const journal = this.checked([
      "/usr/bin/journalctl",
      `_SYSTEMD_INVOCATION_ID=${application.InvocationID}`,
      "--no-pager",
      "-o", "cat",
    ]);
    requireCondition(journal.includes(`\"git_sha\":\"${context.lastKnownGood.git_commit}\"`),
      "The current application invocation did not report the last-known-good runtime SHA.");
    return {
      release_id: context.lastKnownGood.id,
      artifact_path: current,
      git_commit: context.lastKnownGood.git_commit,
      service_invocation_id: application.InvocationID,
      capture_probe: "functional health passed",
      service_probe: "functional health passed",
      runtime_sha: context.lastKnownGood.git_commit,
      admission,
    };
  }

  private prepareUnhealthyRelease(context: RolloutProbeContext) {
    requireCondition(context.lastKnownGood?.artifact_path, "Rollback drill requires a last-known-good release.");
    const fixtureRoot = join(this.environment.releaseRoot, "rollout-fixtures", context.rollout.id);
    requireCondition(!existsSync(fixtureRoot),
      "A prior rollback fixture exists; interrupted rollback effects must not be replayed.");
    mkdirSync(dirname(fixtureRoot), { recursive: true, mode: 0o700 });
    cpSync(context.lastKnownGood.artifact_path, fixtureRoot, { recursive: true, dereference: true });
    normalizedTree(fixtureRoot, 0o700);
    const applicationPath = join(fixtureRoot, "bot/src/index.js");
    const original = readFileSync(applicationPath, "utf8");
    const faulted = original.startsWith("#!")
      ? `${original.slice(0, original.indexOf("\n") + 1)}process.exit(78);\n${original.slice(original.indexOf("\n") + 1)}`
      : `process.exit(78);\n${original}`;
    writeFileSync(applicationPath, faulted, { mode: 0o600 });
    const runtimeFiles = [
      "bot/src/index.js",
      "bot/src/codex-app-server-bridge.mjs",
      "bot/scripts/rename-exchange.py",
    ];
    const manifestPath = join(fixtureRoot, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.runtime_digest = releaseFileSetDigest(fixtureRoot, runtimeFiles);
    manifest.files = Object.fromEntries(runtimeFiles.map((path) => [path, sha256(readFileSync(join(fixtureRoot, path)))]));
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    const artifactDigest = releaseFileSetDigest(fixtureRoot, [...runtimeFiles, "manifest.json"]);
    writeFileSync(join(fixtureRoot, "artifact.sha256"), `${artifactDigest}\n`, { mode: 0o600 });
    writeFileSync(join(fixtureRoot, "builder-result.json"), `${JSON.stringify({
      git_commit: manifest.git_commit,
      artifact_digest: artifactDigest,
      runtime_digest: manifest.runtime_digest,
      compatibility_digest: manifest.compatibility_digest,
    }, null, 2)}\n`, { mode: 0o600 });
    const artifactPath = join(this.environment.releaseRoot, "releases", artifactDigest);
    requireCondition(!existsSync(artifactPath), "The rollback fixture digest already exists unexpectedly.");
    normalizedTree(fixtureRoot, 0o555);
    renameSync(fixtureRoot, artifactPath);
    return { artifactPath, artifactDigest };
  }

  private async containedRollback(context: RolloutProbeContext) {
    this.heldGates(context);
    const prior = this.functionalHealth(context);
    const fixture = this.prepareUnhealthyRelease(context);
    let candidate: { service_invocation_id: string } | null = null;
    try {
      candidate = this.releaseManager.activate(fixture.artifactPath);
      await (this.environment.wait || Bun.sleep)(1_500);
      const unhealthy = this.execute([
        this.environment.bunBin,
        join(this.environment.repositoryRoot, "bot/scripts/healthcheck.ts"),
      ], { env: {
        ...process.env,
        CONCIERGE_CONFIG_PATH: this.environment.slackConfigPath,
        CONCIERGE_PROVIDER_BROKER_ENABLED: "1",
        CONCIERGE_PROVIDER_PROJECTS_PATH: "/var/lib/concierge-bot/provider-projects.json",
        CONCIERGE_STATE_DIR: dirname(this.environment.applicationStatePath),
      } });
      requireCondition(unhealthy.exitCode !== 0, "The deliberately unhealthy post-pointer candidate unexpectedly passed health.");
    } catch (error) {
      if (!candidate) {
        throw new RolloutProbeAmbiguousError(`The rollback candidate activation outcome is ambiguous: ${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    } finally {
      try {
        this.releaseManager.activate(context.lastKnownGood.artifact_path);
      } catch (error) {
        throw new RolloutProbeAmbiguousError(`Last-known-good restoration is ambiguous: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await (this.environment.wait || Bun.sleep)(1_500);
    const restored = this.functionalHealth(context);
    requireCondition(restored.service_invocation_id !== candidate!.service_invocation_id,
      "Last-known-good restoration did not create a new service invocation.");
    return {
      prior_release_id: context.lastKnownGood.id,
      prior_service_invocation_id: prior.service_invocation_id,
      candidate_artifact_digest: fixture.artifactDigest,
      candidate_service_invocation_id: candidate!.service_invocation_id,
      expected_failure: "application process exits with status 78 after stable pointer activation",
      restored_release_id: context.lastKnownGood.id,
      restored_service_invocation_id: restored.service_invocation_id,
      runtime_sha: restored.runtime_sha,
      capture_probe: restored.capture_probe,
      service_probe: restored.service_probe,
      admission: restored.admission,
    };
  }

  private rollbackAlert(context: RolloutProbeContext) {
    const alerts = context.incidentNotifications.filter((notification) => notification.kind === "runtime_restored");
    requireCondition(alerts.length === 1 && alerts[0].status === "delivered" && alerts[0].slack_ts,
      "The contained rollback does not have exactly one delivered restoration alert.");
    return {
      incident_id: context.incident?.id,
      notification_id: alerts[0].id,
      slack_ts: alerts[0].slack_ts,
      client_msg_id: alerts[0].client_msg_id,
      duplicate_count: 0,
    };
  }

  private productionHealth(context: RolloutProbeContext) {
    requireCondition(context.productionActivation?.status === "exposed",
      "The production activation is not exposed.");
    requireCondition(context.productionHandoff?.status === "promoted"
      && context.productionHandoff.handshake_at && context.productionHandoff.heartbeat_at,
    "The production coordinator is not promoted with handshake and heartbeat evidence.");
    const externalAdmission = this.activationGateManager.verify({
      deploymentToken: context.gates.deployment_token,
      captureToken: context.gates.capture_token,
    });
    return {
      ...this.functionalHealth(context, {
        ...this.heldGates(context),
        external: externalAdmission,
      }),
      identity_digest: context.identityDigest,
      activation_generation_id: context.productionActivation.id,
      capabilities: JSON.parse(context.productionActivation.capabilities_json),
      coordinator_unit: context.productionHandoff.candidate_unit,
      coordinator_invocation_id: context.productionHandoff.candidate_invocation_id,
      coordinator_status: context.productionHandoff.status,
      handshake_at: context.productionHandoff.handshake_at,
      heartbeat_at: context.productionHandoff.heartbeat_at,
    };
  }

  recoveryHealth(context: RolloutProbeContext, gateOwnership: Record<string, unknown>) {
    return {
      ...this.functionalHealth(context, gateOwnership),
      identity_digest: context.identityDigest,
      recovery: "last-known-good functional health and exact rollout gate ownership proved",
    };
  }

  releaseRetryHealth(
    context: RolloutProbeContext,
    gateOwnership: Record<string, unknown>,
    expectedProductionHealth: Record<string, any>,
  ) {
    requireCondition(context.gates?.status === "release_requested" || context.gates?.status === "ambiguous",
      "Production gate retry requires a durable release request.");
    requireCondition(expectedProductionHealth.identity_digest === context.identityDigest,
      "Production gate retry identity differs from the passed production proof.");
    requireCondition(expectedProductionHealth.activation_generation_id === context.productionActivation?.id
      && expectedProductionHealth.coordinator_invocation_id === context.productionHandoff?.candidate_invocation_id,
    "Production gate retry activation or coordinator differs from the passed production proof.");
    const current = this.functionalHealth(context, gateOwnership);
    requireCondition(current.service_invocation_id === expectedProductionHealth.service_invocation_id
      && current.runtime_sha === expectedProductionHealth.runtime_sha,
    "Production gate retry service invocation or runtime differs from the passed production proof.");
    return { ...current, identity_digest: context.identityDigest, gate_ownership: gateOwnership };
  }

  async run(name: RolloutProbeName, context: RolloutProbeContext): Promise<Record<string, unknown>> {
    if (!(name in ROLLOUT_PROBES)) throw new Error(`Unknown rollout probe ${name}.`);
    if (name === "application_containment") return this.applicationContainment(context);
    if (name === "control_plane_health") return this.controlPlaneHealth(context);
    if (name === "provider_session_continuity") return this.providerContinuity(context);
    if (name === "security_negative_matrix") return this.securityNegativeMatrix(context);
    if (name === "synthetic_incident") return this.syntheticIncident(context);
    if (name === "canary_recovery") return this.canaryRecovery(context);
    if (name === "last_known_good_health") return this.functionalHealth(context);
    if (name === "contained_rollback") return this.containedRollback(context);
    if (name === "contained_rollback_alert") return this.rollbackAlert(context);
    return this.productionHealth(context);
  }
}
