import { createHmac, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";

interface ProviderAuthorityState {
  schema_version: 1;
  project_id: string;
  sessions: Record<string, "codex" | "claude-code">;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function tokenEqual(actual: string, expected: string) {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function syncPath(path: string) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export class ProviderSessionAuthority {
  private state: ProviderAuthorityState;

  constructor(
    private readonly projectId: string,
    private readonly secret: Buffer,
    private readonly statePath: string,
  ) {
    if (secret.length !== 32) throw new Error("Provider broker secret must be exactly 32 bytes.");
    if (!projectId || projectId.length > 100 || !isAbsolute(statePath)) {
      throw new Error("Provider broker authority identity is invalid.");
    }
    const stateStat = statSync(statePath);
    if (!stateStat.isFile() || (stateStat.mode & 0o077) !== 0) {
      throw new Error("Provider broker session authority must be a private regular file.");
    }
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as ProviderAuthorityState;
    if (parsed.schema_version !== 1 || parsed.project_id !== projectId
      || !parsed.sessions || typeof parsed.sessions !== "object" || Array.isArray(parsed.sessions)) {
      throw new Error("Provider broker session authority is invalid.");
    }
    for (const [sessionUuid, provider] of Object.entries(parsed.sessions)) {
      if (!UUID.test(sessionUuid) || !["codex", "claude-code"].includes(provider)) {
        throw new Error("Provider broker session authority contains an invalid binding.");
      }
    }
    this.state = parsed;
  }

  token(provider: "codex" | "claude-code", sessionUuid: string) {
    return createHmac("sha256", this.secret)
      .update(`${this.projectId}\0${provider}\0${sessionUuid}`)
      .digest("hex");
  }

  has(provider: "codex" | "claude-code", sessionUuid: string) {
    return this.state.sessions[sessionUuid] === provider;
  }

  assert(provider: "codex" | "claude-code", sessionUuid: string, suppliedToken: string | null | undefined) {
    const expectedToken = this.token(provider, sessionUuid);
    if (!this.has(provider, sessionUuid) || !suppliedToken || !tokenEqual(suppliedToken, expectedToken)) {
      throw new Error("Provider session binding is not authorized for this project.");
    }
  }

  authorize(provider: "codex" | "claude-code", sessionUuid: string) {
    if (!UUID.test(sessionUuid)) throw new Error("Provider session identity is invalid.");
    const existing = this.state.sessions[sessionUuid];
    if (existing && existing !== provider) throw new Error("Provider session identity changed provider ownership.");
    if (!existing) {
      this.state.sessions[sessionUuid] = provider;
      const temporary = `${this.statePath}.next`;
      writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
      chmodSync(temporary, 0o600);
      syncPath(temporary);
      renameSync(temporary, this.statePath);
      syncPath(dirname(this.statePath));
    }
    return this.token(provider, sessionUuid);
  }

  filter(provider: "codex" | "claude-code", sessionUuids: string[]) {
    return sessionUuids.filter((sessionUuid) => this.has(provider, sessionUuid));
  }

  list(provider: "codex" | "claude-code") {
    return Object.entries(this.state.sessions)
      .filter(([, assignedProvider]) => assignedProvider === provider)
      .map(([sessionUuid]) => sessionUuid);
  }
}
