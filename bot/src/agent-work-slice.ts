/**
 * The systemd slice every agent's work runs in on Linux: Claude execution hosts and the shared
 * Codex App Server, whose children are Codex agents' commands. remote-box installs the slice unit
 * with the host's disk limit (remote-box systemd/agents.slice). Concierge's own service stays
 * outside it.
 *
 * Why a group cap rather than weights: on 2026-10-09 at 16:52 one agent's `sqlite3 .backup` of a
 * live 3.95 GB database wrote 2.5 GB in 10 s to md2, held the disk at 100% and froze the owner for
 * 145 s. md2 is software RAID, which takes no proportional weights (io.cost and io.latency need a
 * request-queue device), so only a hard limit (io.max) applies. Measured live: agent writes capped
 * at 30 MB/s caused no owner pauses; at 60 MB/s the owner paused up to 0.86 s.
 *
 * If the slice unit is not installed yet, systemd creates the slice with no limits and agents run
 * exactly as before.
 */
export const AGENT_WORK_SLICE = "agents.slice";
