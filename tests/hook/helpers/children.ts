// Builds tests/hook/helpers/child.ts into one CommonJS file and drives it as a child process.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const entry = fileURLToPath(new URL("./child.ts", import.meta.url));

/** Bundles the harness into dir/child.cjs and returns its path. */
export function buildChild(dir: string): string {
  const outfile = join(dir, "child.cjs");
  buildSync({ entryPoints: [entry], outfile, bundle: true, platform: "node", format: "cjs", target: "node22", logLevel: "warning" });
  return outfile;
}

export interface Child {
  process: ChildProcessWithoutNullStreams;
  lines: string[];
  /** Resolves with the first output line matching the pattern (rejects when the child exits first). */
  waitFor(pattern: RegExp, timeoutMs?: number): Promise<string>;
  /** Resolves with the exit code once the child has exited. */
  exited: Promise<number | null>;
  kill(): Promise<void>;
}

export function startChild(bundle: string, args: string[], env: NodeJS.ProcessEnv = process.env): Child {
  const child = spawn(process.execPath, ["--no-warnings", bundle, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
  const lines: string[] = [];
  const waiters: { pattern: RegExp; resolve: (line: string) => void; reject: (e: Error) => void }[] = [];
  let buffer = "";
  let stderr = "";
  let done = false;
  child.stdout.setEncoding("utf8").on("data", (text: string) => {
    buffer += text;
    let at: number;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      lines.push(line);
      for (const w of [...waiters]) {
        if (w.pattern.test(line)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(line);
        }
      }
    }
  });
  child.stderr.setEncoding("utf8").on("data", (text: string) => (stderr += text));
  const exited = new Promise<number | null>((resolve) =>
    child.on("close", (code) => {
      done = true;
      for (const w of waiters.splice(0)) w.reject(new Error(`child exited (${String(code)}) before ${w.pattern}: ${stderr}`));
      resolve(code);
    }),
  );
  child.stdin.end();

  return {
    process: child,
    lines,
    exited,
    waitFor(pattern, timeoutMs = 15_000) {
      const seen = lines.find((line) => pattern.test(line));
      if (seen !== undefined) return Promise.resolve(seen);
      if (done) return Promise.reject(new Error(`child already exited: ${stderr}`));
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${pattern}: ${stderr}`)), timeoutMs);
        waiters.push({
          pattern,
          resolve: (line) => (clearTimeout(timer), resolve(line)),
          reject: (e) => (clearTimeout(timer), reject(e)),
        });
      });
    },
    async kill() {
      if (!done) child.kill("SIGKILL");
      await exited;
    },
  };
}
