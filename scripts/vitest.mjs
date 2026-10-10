// Starts Vitest from the real spelling of the working directory.
//
// On Windows a shell may report the working directory with a lower-case drive letter
// ("e:\project") while the file system spells it "E:\project". Vitest then loads its runner
// under one spelling and the test files' `vitest` import under the other: two copies of the
// module, and every test file fails with "Vitest failed to find the current suite".
// Using the native real path for both the working directory and the Vitest entry point keeps a
// single spelling. Elsewhere the real path is the path itself, so this changes nothing.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const cwd = realpathSync.native(process.cwd());
const require = createRequire(join(cwd, "package.json"));
const vitestDir = dirname(realpathSync.native(require.resolve("vitest/package.json")));
const { bin } = require(join(vitestDir, "package.json"));
const entry = join(vitestDir, typeof bin === "string" ? bin : bin.vitest);

const result = spawnSync(process.execPath, [entry, ...process.argv.slice(2)], { cwd, stdio: "inherit" });
if (result.error) {
  console.error(`Could not start Vitest: ${result.error.message}`);
  process.exit(1);
}
// End the same way Vitest did: on its signal (Ctrl+C, SIGTERM, crash), otherwise with its exit code.
if (result.signal) process.kill(process.pid, result.signal);
else process.exit(result.status ?? 1);
