export interface DeploymentWorkerWakeServices {
  mainPid(): number;
  signal(pid: number): void;
}

function productionServices(): DeploymentWorkerWakeServices {
  return {
    mainPid() {
      const result = Bun.spawnSync({
        cmd: ["systemctl", "show", "concierge-bot.service", "--property=MainPID", "--value"],
        stdout: "pipe",
        stderr: "ignore",
      });
      if (result.exitCode !== 0) return 0;
      return Number(Buffer.from(result.stdout).toString("utf8").trim());
    },
    signal(pid) {
      process.kill(pid, "SIGUSR2");
    },
  };
}

export function notifyDeploymentWorker(
  services: DeploymentWorkerWakeServices = productionServices(),
): boolean {
  const pid = services.mainPid();
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    services.signal(pid);
    return true;
  } catch {
    return false;
  }
}
