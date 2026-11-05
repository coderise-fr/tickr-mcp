// A flusher store and a StageContext with fake clocks, for the stage tests.
import { join } from "node:path";
import { OFFLINE_API } from "../../../hook-src/flusher/api.js";
import { claimOwnership, guarded } from "../../../hook-src/flusher/owner.js";
import type { FlusherBoundary, StageContext } from "../../../hook-src/flusher/stages.js";
import { ulid } from "../../../hook-src/ids.js";
import { canonicalJson, DEFAULT_DESCRIPTION, type NormalizedMapping } from "../../../hook-src/mapping.js";
import { DB_FILE, type JournalEvent, openStore, type Store } from "../../../hook-src/store/db.js";
import { PROJECT, pluginConfig, tempDir, WS } from "./env.js";

export const MAPPING: NormalizedMapping = { workspaceId: WS, projectId: PROJECT, taskId: null, tagIds: [], description: DEFAULT_DESCRIPTION };

/** The journal form of a normalised mapping (what hooks and fallback files carry). */
export function journalMapping(m: NormalizedMapping = MAPPING): { hash: string; json: string } {
  return { hash: "", json: canonicalJson(m) };
}

export interface StageHarness {
  store: Store;
  dir: string;
  ctx: StageContext;
  boundaries: FlusherBoundary[];
  /** Sets the flusher's wall clock. */
  setNow(iso: string): void;
  /** Journals one event of the session at `localTime` with an uptime (seconds). */
  journal(type: string, localTime: string, uptimeS: number, extra?: Partial<JournalEvent>): void;
  close(): void;
}

export function stageHarness(opts: { now: string; idleMinutes?: number; remainingMs?: number }): StageHarness {
  const dir = tempDir();
  const store = openStore(join(dir, DB_FILE), { role: "flusher", busyTimeoutMs: 5000 }) as Store;
  let now = new Date(opts.now);
  const generation = claimOwnership(store, 1, now.toISOString())!;
  const boundaries: FlusherBoundary[] = [];
  const ctx: StageContext = {
    store,
    generation,
    instanceDir: dir,
    config: { ...pluginConfig(dir), idleMinutes: opts.idleMinutes ?? 15 },
    api: OFFLINE_API,
    now: () => new Date(now.getTime()),
    uptime: () => 1000,
    remainingMs: () => opts.remainingMs ?? 60_000,
    guarded: (fn) => guarded(store, generation, now.toISOString(), fn),
    boundary: (point) => boundaries.push(point),
  };
  return {
    store,
    dir,
    ctx,
    boundaries,
    setNow: (iso) => (now = new Date(iso)),
    journal: (type, localTime, uptimeS, extra = {}) => {
      store.journal({
        eventId: ulid(Date.parse(localTime)),
        sessionId: "s-1",
        type,
        localTime,
        uptimeS,
        mapping: journalMapping(),
        provider: "anthropic",
        ...extra,
      });
    },
    close: () => store.close(),
  };
}
