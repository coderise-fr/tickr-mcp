// Dev only (not published). Stdio proxy for a manual run: starts the given command, copies the
// `initialize` request the client sends to <out.json> keeping only
// params.clientInfo and params.protocolVersion, then passes everything else through unchanged.
//
//   node scripts/capture-initialize.mjs <out.json> -- <command> [args...]
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const split = argv.indexOf("--");
if (split < 1 || split === argv.length - 1) {
  console.error("usage: capture-initialize.mjs <out.json> -- <command> [args...]");
  process.exit(2);
}
const out = argv[0];
const [command, ...args] = argv.slice(split + 1);

const child = spawn(command, args, { stdio: ["pipe", "inherit", "inherit"] });
let captured = false;
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  // Recent Claude Code versions first send a "server/discover" probe: wait for `initialize`.
  if (!captured) {
    try {
      const message = JSON.parse(line);
      if (message.method === "initialize") {
        captured = true;
        const { clientInfo, protocolVersion } = message.params ?? {};
        writeFileSync(out, JSON.stringify({ params: { protocolVersion, clientInfo } }, null, 2) + "\n");
      }
    } catch {
      // not JSON: passed through unchanged
    }
  }
  child.stdin.write(line + "\n");
});
lines.on("close", () => child.stdin.end());
child.on("exit", (code, signal) => (signal ? process.kill(process.pid, signal) : process.exit(code ?? 1)));
