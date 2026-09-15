import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { grafanaBearer } from "../src/grafana-webhook";

export function provisionGrafanaCredential(queuePath: string, outputPath: string) {
  const parent = lstatSync(dirname(outputPath));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077)) throw new Error("Credential directory must be private.");
  const sourceFd = openSync(queuePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let credential: string;
  try {
    const source = fstatSync(sourceFd);
    if (!source.isFile() || (source.mode & 0o077)) throw new Error("Queue credential must be a private regular file.");
    credential = grafanaBearer(readFileSync(sourceFd, "utf8").trim()) + "\n";
  } finally { closeSync(sourceFd); }
  let output: number;
  try { output = openSync(outputPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error: any) {
    if (error.code !== "EEXIST") throw error;
    const existing = openSync(outputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const file = fstatSync(existing);
      if (!file.isFile() || (file.mode & 0o077) || readFileSync(existing, "utf8") !== credential) {
        throw new Error("Existing Grafana credential differs or is unsafe; coordinate rotation with the Grafana operator.");
      }
    } finally { closeSync(existing); }
    return;
  }
  try { writeFileSync(output, credential); fsyncSync(output); } finally { closeSync(output); }
}

if (import.meta.main) {
  const flag = (name: string, fallback: string) => {
    const index = process.argv.indexOf(name);
    return index < 0 ? fallback : process.argv[index + 1] || "";
  };
  provisionGrafanaCredential(flag("--queue-token-file", "/etc/concierge/capture-queue.token"),
    flag("--output", "/etc/concierge/grafana-alerts.token"));
  console.log("Grafana credential file verified; secret value withheld.");
}
