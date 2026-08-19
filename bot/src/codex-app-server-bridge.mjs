import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import WebSocket from "ws-node";

const socketPath = process.argv[2];
const initializeId = "slack-concierge-initialize";
let ready = false;
let disconnectReported = false;

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function disconnect(error) {
  if (disconnectReported) return;
  disconnectReported = true;
  write({ type: "disconnect", error: error instanceof Error ? error.message : String(error) });
}

const appServer = new WebSocket("ws://localhost/", {
  createConnection: () => createConnection(socketPath),
  perMessageDeflate: false,
});

appServer.on("open", () => {
  appServer.send(JSON.stringify({
    id: initializeId,
    method: "initialize",
    params: {
      clientInfo: { name: "slack_concierge", title: "Slack Concierge", version: "0.2.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    },
  }));
});

appServer.on("message", (data) => {
  let message;
  try {
    message = JSON.parse(data.toString());
  } catch {
    return;
  }
  if (message.id === initializeId) {
    if (message.error) {
      disconnect(new Error(`initialize failed: ${message.error.message || JSON.stringify(message.error)}`));
      appServer.close();
      return;
    }
    appServer.send(JSON.stringify({ method: "initialized", params: {} }));
    ready = true;
    write({ type: "ready" });
    return;
  }
  if (Object.prototype.hasOwnProperty.call(message, "id") && ("result" in message || "error" in message)) {
    write({ type: "response", id: message.id, result: message.result, error: message.error });
    return;
  }
  if (Object.prototype.hasOwnProperty.call(message, "id") && message.method) {
    appServer.send(JSON.stringify({
      id: message.id,
      error: { code: -32601, message: `Slack Concierge cannot answer server request ${message.method}.` },
    }));
    return;
  }
  if (message.method) write({ type: "event", event: message });
});

appServer.on("error", disconnect);
appServer.on("close", () => {
  disconnect(new Error("Codex app-server WebSocket closed."));
  input.close();
  process.exit(ready ? 0 : 1);
});

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.type === "close") {
    appServer.close();
    return;
  }
  if (appServer.readyState !== WebSocket.OPEN || !ready) return;
  if (message.type === "request") {
    appServer.send(JSON.stringify({ id: message.id, method: message.method, params: message.params }));
  } else if (message.type === "notification") {
    appServer.send(JSON.stringify({ method: message.method, params: message.params }));
  }
});

input.on("close", () => appServer.close());
process.on("SIGTERM", () => appServer.close());
