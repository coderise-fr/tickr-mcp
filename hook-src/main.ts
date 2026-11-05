// Entry point of the plugin bundle (plugins/tickr/hooks/dist/tickr-hook.cjs).
// argv: <HookEvent> | flush <instanceDir> | status <dataDir>
export async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  void argv;
  void env;
  return 0;
}

// Set to true by scripts/build-hook.mjs: the bundle runs main(), the sources imported by tests do not.
declare const TICKR_HOOK_BUNDLE: boolean | undefined;
if (typeof TICKR_HOOK_BUNDLE !== "undefined" && TICKR_HOOK_BUNDLE) {
  void main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    () => process.exit(0),
  );
}
