import { test, expect } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionGrafanaCredential } from "../scripts/grafana-credential";
import { grafanaBearer } from "../src/grafana-webhook";

test("private handoff derives only the route credential and is idempotent without replacing mismatched files", () => {
  const dir = mkdtempSync(join(tmpdir(), "grafana-credential-"));
  try {
    const source = join(dir, "queue"), target = join(dir, "grafana");
    writeFileSync(source, "private-test-queue-key\n", { mode: 0o600 });
    provisionGrafanaCredential(source, target);
    expect(readFileSync(target, "utf8")).toBe(grafanaBearer("private-test-queue-key") + "\n");
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(() => provisionGrafanaCredential(source, target)).not.toThrow();
    writeFileSync(target, "different");
    expect(() => provisionGrafanaCredential(source, target)).toThrow("differs or is unsafe");
    expect(readFileSync(target, "utf8")).toBe("different");
    const link = join(dir, "link"); symlinkSync(source, link);
    expect(() => provisionGrafanaCredential(link, join(dir, "new"))).toThrow();
    expect(() => provisionGrafanaCredential(source, link)).toThrow();
    chmodSync(source, 0o644);
    expect(() => provisionGrafanaCredential(source, join(dir, "new"))).toThrow("private regular");
    chmodSync(dir, 0o755);
    expect(() => provisionGrafanaCredential(source, join(dir, "new"))).toThrow("directory must be private");
  } finally { rmSync(dir, { recursive: true }); }
});
