// Starts the detached flusher of an instance from a hook. The hook calls it only when no owner
// heartbeat is fresh (< 2 min, read in its own transaction; always after a fallback file). The
// API key travels in the inherited environment only, never in argv (PD-18): argv is visible in
// process lists.
import { spawn } from "node:child_process";

export function spawnFlusher(bundlePath: string, instanceDir: string, env: NodeJS.ProcessEnv): void {
  const child = spawn(process.execPath, ["--no-warnings", bundlePath, "flush", instanceDir], {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env,
  });
  child.on("error", () => undefined);
  child.unref();
}
