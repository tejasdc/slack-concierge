import { LogLevel, SocketModeReceiver } from "@slack/bolt";
import type { ResolvedRuntimeProfile } from "./runtime-profile";

type IdentityFailureHandler = (error: Error) => void;

function bodyTeamId(body: Record<string, any>) {
  return String(body.team_id || body.team?.id || body.user?.team_id || "");
}

function bodyAppId(body: Record<string, any>) {
  return String(body.api_app_id || "");
}

function appIdentityMayComeFromSocket(body: Record<string, any>) {
  return body.type === "shortcut" || body.type === "message_action";
}

export class SandboxSlackIdentityGate {
  readonly receiver: SocketModeReceiver;
  private connectedAppId: string | null = null;
  private identityFailure: Error | null = null;
  private failureHandler: IdentityFailureHandler | null = null;

  constructor(
    private readonly runtime: ResolvedRuntimeProfile,
    appToken: string,
  ) {
    if (runtime.profile !== "sandbox") {
      throw new Error("Sandbox Slack identity gate requires the sandbox runtime profile.");
    }
    this.receiver = new SocketModeReceiver({ appToken, logLevel: LogLevel.INFO });
    this.receiver.client.on("ws_message", (data: any, isBinary: boolean) => {
      this.observeSocketMessage(data, isBinary);
    });
  }

  setFailureHandler(handler: IdentityFailureHandler) {
    this.failureHandler = handler;
    if (this.identityFailure) handler(this.identityFailure);
  }

  observeSocketMessage(data: { toString(): string }, isBinary: boolean) {
    if (isBinary) return;
    let message: any;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (message?.type !== "hello") return;

    const appId = String(message.connection_info?.app_id || "");
    if (appId !== this.runtime.expectedSlackAppId) {
      this.fail(new Error("Socket Mode app token does not belong to the expected sandbox lane app."));
      return;
    }
    this.connectedAppId = appId;
  }

  assertConnected() {
    if (this.identityFailure) throw this.identityFailure;
    if (this.connectedAppId !== this.runtime.expectedSlackAppId) {
      throw new Error("Socket Mode did not provide the expected sandbox app identity before startup completed.");
    }
  }

  assertInbound(body: Record<string, any>) {
    this.assertConnected();
    if (bodyTeamId(body) !== this.runtime.expectedSlackTeamId) {
      throw new Error("Inbound Slack payload does not belong to the expected sandbox workspace.");
    }

    const apiAppId = bodyAppId(body);
    if (apiAppId) {
      if (apiAppId !== this.runtime.expectedSlackAppId) {
        throw new Error("Inbound Slack payload does not belong to the expected sandbox app.");
      }
      return;
    }
    if (!appIdentityMayComeFromSocket(body)) {
      throw new Error("Inbound Slack payload is missing a verifiable sandbox app identity.");
    }
  }

  private fail(error: Error) {
    if (this.identityFailure) return;
    this.identityFailure = error;
    this.connectedAppId = null;
    this.failureHandler?.(error);
  }
}

export function sandboxSlackIdentityMiddleware(gate: SandboxSlackIdentityGate) {
  return async ({ body, next }: { body: Record<string, any>; next: () => Promise<void> }) => {
    gate.assertInbound(body);
    await next();
  };
}
