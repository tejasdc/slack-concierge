import { createServer } from "node:http";
import WebSocket, { WebSocketServer } from "ws-node";

const socketPath = process.argv[2];
const server = createServer();
const webSockets = new WebSocketServer({ noServer: true, perMessageDeflate: false });
let connections = 0;
let initializations = 0;
let initialized = 0;

server.on("upgrade", (request, socket, head) => {
  webSockets.handleUpgrade(request, socket, head, (webSocket) => {
    webSockets.emit("connection", webSocket, request);
  });
});

webSockets.on("connection", (socket) => {
  connections += 1;
  socket.on("message", (data) => {
    const message = JSON.parse(String(data));
    if (message.method === "initialize") {
      initializations += 1;
      socket.send(JSON.stringify({ id: message.id, result: { userAgent: "test" } }));
    } else if (message.method === "initialized") {
      initialized += 1;
    } else if (message.method === "test/stats") {
      socket.send(JSON.stringify({
        id: message.id,
        result: { connections, initializations, initialized },
      }));
    } else if (message.method === "test/emit") {
      socket.send(JSON.stringify({ id: message.id, result: { emitted: true } }));
      socket.send(JSON.stringify({ method: "turn/completed", params: { turn: { id: "turn-1" } } }));
    } else if (message.method === "test/disconnect") {
      socket.send(JSON.stringify({ id: message.id, result: { disconnecting: true } }));
      setImmediate(() => socket.close());
    } else if (message.id) {
      socket.send(JSON.stringify({ id: message.id, result: { method: message.method } }));
    }
  });
});

server.listen(socketPath, () => process.stdout.write("ready\n"));

process.on("SIGTERM", () => {
  for (const socket of webSockets.clients) {
    if (socket.readyState === WebSocket.OPEN) socket.terminate();
  }
  webSockets.close(() => server.close(() => process.exit(0)));
});
