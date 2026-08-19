import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const controlPath = process.argv[2];
const mode = controlPath.split("-").at(-1);

process.stdout.write(`${JSON.stringify({ type: "ready" })}\n`);

if (mode === "epipe") {
  process.stdin.destroy();
  setTimeout(() => process.exit(17), 100);
} else {
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.type !== "close" || mode === "stubborn") return;
    setTimeout(() => {
      writeFileSync(`${controlPath}.exited`, "graceful");
      process.exit(0);
    }, 40);
  });
  process.on("SIGTERM", () => {
    if (mode === "stubborn") {
      writeFileSync(`${controlPath}.sigterm`, "observed");
      return;
    }
    process.exit(0);
  });
}
