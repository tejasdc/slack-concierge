import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log } from "./log";

/**
 * A bug report's screenshot on this Mac, taken on this Mac and handed straight back to the page.
 *
 * thnkr.ing's bug report used to send S to the server, which handed the job to thnkr.ing Capture
 * on this Mac; the Capture app took the shot, uploaded it to the server, and the server sent it
 * back down to the page. A one-second system call became five seconds of picture travelling
 * across the internet twice (report of 2026-11-02 00:44 ET: S at 05:44:36.6Z, picture shown
 * 5.2 s later, 2.6 s of it uploading 1 MB). The ⌃Space bar never had that cost because its
 * picture never left the Mac.
 *
 * So the page asks here, on this Mac's loopback address (the same listener and certificate as
 * live speech), and this asks thnkr.ing Capture through its URL scheme to take the shot into a
 * file in a fresh private folder. Concierge itself never touches the screen: macOS grants screen
 * recording to the Capture app by name, and that grant stays where it is. The Capture app marks
 * the job started at once, so an app too old to know the action is found within seconds and the
 * page falls back to the server relay. Nothing here reaches the server.
 *
 * Known limit: like every loopback route here, a program already running as him on this Mac can
 * call it; the browser can only reach it from thnkr.ing's origin.
 */
const STARTED_WITHIN_MS = 4_000;
// An area shot waits for his drag in the crosshair; the server relay allowed two minutes too.
const FINISHED_WITHIN_MS = 120_000;
const POLL_MS = 40;

type Result = { outcome: "image" | "cancelled" | "refused"; reason?: "permission" | "failed" };
export class ScreenshotRefusal extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}

let busy = false;

const exists = (path: string) => stat(path).then(() => true, () => false);
async function waitFor(path: string, withinMs: number, signal: AbortSignal) {
  const until = Date.now() + withinMs;
  while (Date.now() < until) {
    if (signal.aborted) return false;
    if (await exists(path)) return true;
    await Bun.sleep(POLL_MS);
  }
  return false;
}

/** Takes one shot through thnkr.ing Capture: the picture's bytes, or why there is none. */
export async function takeLocalScreenshot(kind: "area" | "screen", signal: AbortSignal): Promise<{ png: Buffer } | Result> {
  if (busy) throw new ScreenshotRefusal("SCREENSHOT_BUSY", 409);
  busy = true;
  const started = Date.now();
  const directory = await mkdtemp(join(tmpdir(), "thnkr-report-shot-"));
  const file = join(directory, "shot.png");
  let outcome = "unavailable";
  try {
    const url = `thnkring-capture://report-shot?file=${encodeURIComponent(file)}${kind === "screen" ? "&whole=1" : ""}`;
    // -g: hand the URL to the app without bringing it forward; the crosshair is the system's.
    spawn("open", ["-g", url], { stdio: "ignore" }).on("error", () => {});
    if (!(await waitFor(`${file}.started`, STARTED_WITHIN_MS, signal))) throw new ScreenshotRefusal("CAPTURE_APP_UNAVAILABLE", 503);
    if (!(await waitFor(`${file}.result.json`, FINISHED_WITHIN_MS, signal))) throw new ScreenshotRefusal("SCREENSHOT_TIMED_OUT", 504);
    const result = JSON.parse(await readFile(`${file}.result.json`, "utf8")) as Result;
    outcome = result.outcome;
    if (result.outcome !== "image") return result;
    const png = await readFile(file);
    if (!png.length) { outcome = "failed"; return { outcome: "refused", reason: "failed" }; }
    log("info", "local_screenshot", { kind, outcome, bytes: png.length, total_ms: Date.now() - started });
    return { png };
  } catch (error) {
    if (error instanceof ScreenshotRefusal) outcome = error.code;
    throw error;
  } finally {
    busy = false;
    if (outcome !== "image") log("info", "local_screenshot", { kind, outcome, total_ms: Date.now() - started });
    await rm(directory, { recursive: true, force: true });
  }
}
