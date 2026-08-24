import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export type CoordinatorRuntimeSlot = "legacy" | "a" | "b";

export interface CoordinatorRuntimeIdentity {
  slot: CoordinatorRuntimeSlot;
  version: string;
  unit: string;
  invocationId: string;
  mainPid: number;
  active: boolean;
}

export interface CoordinatorCandidateIdentity extends CoordinatorRuntimeIdentity {
  slot: "a" | "b";
}

interface CoordinatorCatalog {
  schema_version: 1;
  candidate_slot: "a" | "b";
  candidate_version: string;
  slots: Partial<Record<"a" | "b", string>>;
}

export interface CoordinatorRuntimeEnvironment {
  runtimeRoot: string;
  activeRecordPath: string;
  systemctlBin: string;
  run?: (args: string[]) => { exitCode: number; stdout: string; stderr: string };
}

interface ActiveCoordinatorRecord {
  schema_version: 1;
  slot: CoordinatorRuntimeSlot;
  version: string;
  unit: string;
  promoted_generation_id: string | null;
}

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function assertDigest(value: string, label: string) {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest.`);
}

function unitForSlot(slot: CoordinatorRuntimeSlot) {
  return slot === "legacy"
    ? "concierge-deployment-coordinator.service"
    : `concierge-deployment-coordinator@${slot}.service`;
}

function parseProperties(output: string) {
  return Object.fromEntries(output.trim().split("\n").filter(Boolean).map((line) => {
    const separator = line.indexOf("=");
    return separator < 0 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

export function defaultCoordinatorRuntimeEnvironment(): CoordinatorRuntimeEnvironment {
  return {
    runtimeRoot: process.env.CONCIERGE_DEPLOYMENT_RUNTIME_DIR || "/usr/local/lib/concierge-deployment",
    activeRecordPath: process.env.CONCIERGE_COORDINATOR_ACTIVE_RECORD
      || "/var/lib/concierge-deployment/coordinator-active.json",
    systemctlBin: process.env.CONCIERGE_SYSTEMCTL_BIN || "/usr/bin/systemctl",
  };
}

export class CoordinatorRuntimeManager {
  constructor(readonly environment = defaultCoordinatorRuntimeEnvironment()) {}

  private execute(args: string[]) {
    if (this.environment.run) return this.environment.run(args);
    const result = Bun.spawnSync({
      cmd: [this.environment.systemctlBin, ...args],
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  }

  private checked(args: string[]) {
    const result = this.execute(args);
    if (result.exitCode !== 0) {
      throw new Error(`systemctl ${args[0]} failed: ${result.stderr.trim().slice(0, 500) || "unknown error"}`);
    }
    return result.stdout;
  }

  private writeActive(record: ActiveCoordinatorRecord) {
    mkdirSync(dirname(this.environment.activeRecordPath), { recursive: true, mode: 0o755 });
    const temporary = `${this.environment.activeRecordPath}.${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.environment.activeRecordPath);
    return record;
  }

  observeUnit(unit: string) {
    const properties = parseProperties(this.checked([
      "show",
      unit,
      "--property=InvocationID,MainPID,ActiveState",
    ]));
    return {
      invocationId: properties.InvocationID || "",
      mainPid: Number(properties.MainPID || "0"),
      active: properties.ActiveState === "active",
    };
  }

  validateCandidate(slot: "a" | "b", version: string): CoordinatorCandidateIdentity {
    assertDigest(version, "coordinator candidate version");
    const slotPath = join(resolve(this.environment.runtimeRoot), "coordinator", "slots", slot);
    if (!existsSync(slotPath) || !lstatSync(slotPath).isSymbolicLink()) {
      throw new Error(`Coordinator slot ${slot} is not an installed root-owned symlink.`);
    }
    const realSlotPath = realpathSync(slotPath);
    if (basename(realSlotPath) !== version || dirname(realSlotPath) !== join(resolve(this.environment.runtimeRoot), "coordinator")) {
      throw new Error(`Coordinator slot ${slot} does not resolve to candidate ${version}.`);
    }
    const manifestPath = join(realSlotPath, "manifest.json");
    const bundlePath = join(realSlotPath, "coordinator.js");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.version !== version || manifest.coordinator_bundle_sha256 !== sha256(readFileSync(bundlePath))) {
      throw new Error(`Coordinator slot ${slot} manifest does not match its immutable bundle.`);
    }
    const unit = unitForSlot(slot);
    const observed = this.observeUnit(unit);
    return { slot, version, unit, ...observed };
  }

  stagedCandidate(): CoordinatorCandidateIdentity | null {
    const catalogPath = join(resolve(this.environment.runtimeRoot), "coordinator", "catalog.json");
    if (!existsSync(catalogPath)) return null;
    const stat = lstatSync(catalogPath);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
      throw new Error("Coordinator catalog is not protected root-owned state.");
    }
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as CoordinatorCatalog;
    if (catalog.schema_version !== 1
      || (catalog.candidate_slot !== "a" && catalog.candidate_slot !== "b")
      || !/^[0-9a-f]{64}$/.test(catalog.candidate_version)
      || catalog.slots?.[catalog.candidate_slot] !== catalog.candidate_version) {
      throw new Error("Coordinator catalog has no exact staged candidate authority.");
    }
    return this.validateCandidate(catalog.candidate_slot, catalog.candidate_version);
  }

  incumbent(): CoordinatorRuntimeIdentity | null {
    let record: ActiveCoordinatorRecord | null = null;
    if (existsSync(this.environment.activeRecordPath)) {
      const stat = lstatSync(this.environment.activeRecordPath);
      if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
        throw new Error("Coordinator active record is not protected root-owned state.");
      }
      const parsed = JSON.parse(readFileSync(this.environment.activeRecordPath, "utf8"));
      if (parsed?.schema_version !== 1 || !["legacy", "a", "b"].includes(parsed.slot)
        || parsed.unit !== unitForSlot(parsed.slot)) {
        throw new Error("Coordinator active record is invalid.");
      }
      assertDigest(parsed.version, "coordinator active version");
      record = parsed as ActiveCoordinatorRecord;
    } else {
      const current = join(resolve(this.environment.runtimeRoot), "coordinator", "current");
      if (!existsSync(current)) return null;
      const version = basename(realpathSync(current));
      assertDigest(version, "legacy coordinator version");
      record = {
        schema_version: 1,
        slot: "legacy",
        version,
        unit: unitForSlot("legacy"),
        promoted_generation_id: null,
      };
    }
    if (record.slot === "a" || record.slot === "b") {
      return this.validateCandidate(record.slot, record.version);
    }
    const legacyRoot = join(resolve(this.environment.runtimeRoot), "coordinator", "current");
    if (basename(realpathSync(legacyRoot)) !== record.version) {
      throw new Error("Legacy coordinator active record does not match the immutable current bundle.");
    }
    const observed = this.observeUnit(record.unit);
    return { slot: record.slot, version: record.version, unit: record.unit, ...observed };
  }

  startCandidate(slot: "a" | "b", version: string) {
    const candidate = this.validateCandidate(slot, version);
    if (!candidate.active) this.checked(["start", candidate.unit]);
    const observed = this.validateCandidate(slot, version);
    if (!observed.active || observed.mainPid <= 1 || !observed.invocationId) {
      throw new Error(`Coordinator candidate ${observed.unit} did not become active.`);
    }
    return observed;
  }

  stop(unit: string) {
    this.checked(["stop", unit]);
    const observed = this.observeUnit(unit);
    if (observed.active || observed.mainPid > 0) throw new Error(`Coordinator unit ${unit} remained active after stop.`);
    return observed;
  }

  recoverIncumbent(input: {
    candidateUnit: string;
    incumbentSlot: CoordinatorRuntimeSlot | null;
    incumbentVersion: string | null;
    incumbentUnit: string | null;
    incumbentWasActive: boolean;
  }) {
    this.stop(input.candidateUnit);
    if (!input.incumbentWasActive || !input.incumbentUnit) return null;
    this.checked(["start", input.incumbentUnit]);
    const observed = this.observeUnit(input.incumbentUnit);
    if (!observed.active || observed.mainPid <= 1 || !observed.invocationId) {
      throw new Error(`Coordinator incumbent ${input.incumbentUnit} did not recover.`);
    }
    if (!input.incumbentSlot || !input.incumbentVersion) {
      throw new Error(`Coordinator incumbent ${input.incumbentUnit} lacks recoverable slot identity.`);
    }
    this.checked(["enable", input.incumbentUnit]);
    if (input.candidateUnit !== input.incumbentUnit) this.checked(["disable", input.candidateUnit]);
    this.writeActive({
      schema_version: 1,
      slot: input.incumbentSlot,
      version: input.incumbentVersion,
      unit: input.incumbentUnit,
      promoted_generation_id: null,
    });
    return observed;
  }

  promote(input: { generationId: string; slot: "a" | "b"; version: string; unit: string; incumbentUnit: string | null }) {
    const candidate = this.validateCandidate(input.slot, input.version);
    if (!candidate.active || candidate.unit !== input.unit) {
      throw new Error(`Coordinator candidate ${input.unit} is not active at promotion.`);
    }
    this.checked(["enable", input.unit]);
    if (input.incumbentUnit && input.incumbentUnit !== input.unit) this.checked(["disable", input.incumbentUnit]);
    const record: ActiveCoordinatorRecord = {
      schema_version: 1,
      slot: input.slot,
      version: input.version,
      unit: input.unit,
      promoted_generation_id: input.generationId,
    };
    return this.writeActive(record);
  }
}
