// The "bounds" stage: local quotas and retention of one instance (§7.4).
//
// - Superseded revisions are pruned: only the latest revision of a target is ever sent, and an
//   acknowledgement of revision N removes N and every older one, so an older pending row has no
//   use. An instance offline for days thus keeps one pending row per target, not one per minute.
// - Bounds: at most MAX_PENDING_ROWS pending outbox rows (after pruning: one per target) and
//   MAX_INSTANCE_BYTES for the database, its rollback journal and fallback/. Reaching one sets
//   meta intake_paused (hooks then journal nothing) and queues one notice; nothing pending is
//   deleted. Intake resumes once both are below their bound again.
// - Retention: acknowledged data older than 90 days is deleted, at most once a day, then the
//   database is vacuumed.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { FALLBACK_DIR } from "../fallback.js";
import { INTAKE_PAUSED_KEY } from "../intake.js";
import { addNotice } from "../notices.js";
import { DB_FILE, type Store } from "../store/db.js";
import type { StageRun } from "./stages.js";

export const MAX_PENDING_ROWS = 500;
export const MAX_INSTANCE_BYTES = 50 * 1024 * 1024;
export const RETENTION_MS = 90 * 24 * 60 * 60_000;
export const RETENTION_INTERVAL_MS = 24 * 60 * 60_000;
/** meta: when retention last ran. */
export const RETENTION_KEY = "retention_at";

function fileSize(path: string): number {
  try {
    const st = statSync(path);
    return st.isFile() ? st.size : 0;
  } catch {
    return 0;
  }
}

function dirSize(dir: string): number {
  let total = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const path = join(dir, name);
    try {
      const st = statSync(path);
      total += st.isDirectory() ? dirSize(path) : st.size;
    } catch {
      // Removed meanwhile (an imported fallback file).
    }
  }
  return total;
}

/** Bytes the instance occupies: database + rollback journal + fallback files. */
export function instanceBytes(dir: string): number {
  return fileSize(join(dir, DB_FILE)) + fileSize(join(dir, `${DB_FILE}-journal`)) + dirSize(join(dir, FALLBACK_DIR));
}

export interface BoundsOptions {
  maxPendingRows?: number;
  maxBytes?: number;
}

function vacuum(store: Store): void {
  try {
    store.db.exec("VACUUM");
  } catch {
    // Locked by a hook: the next run tries again.
  }
}

export function boundsStage(opts: BoundsOptions = {}): StageRun {
  const maxRows = opts.maxPendingRows ?? MAX_PENDING_ROWS;
  const maxBytes = opts.maxBytes ?? MAX_INSTANCE_BYTES;
  return (ctx) => {
    const { store } = ctx;
    ctx.guarded(() => store.pruneSupersededOutbox());

    const now = ctx.now();
    const last = Date.parse(store.getMeta(RETENTION_KEY) ?? "");
    if (!Number.isFinite(last) || now.getTime() - last >= RETENTION_INTERVAL_MS || last > now.getTime()) {
      const cutoff = new Date(now.getTime() - RETENTION_MS).toISOString();
      const deleted = ctx.guarded(() => {
        store.setMeta(RETENTION_KEY, now.toISOString());
        return store.deleteRetired(cutoff);
      });
      if (deleted > 0) vacuum(store);
    }

    const over = () => store.pendingOutboxCount() >= maxRows || instanceBytes(ctx.instanceDir) >= maxBytes;
    // Free pages left by deletions count against the quota until the file is vacuumed.
    if (over() && store.freePages() > 0) vacuum(store);
    const reached = over();
    ctx.guarded(() => {
      const paused = store.getMeta(INTAKE_PAUSED_KEY) !== null;
      if (reached && !paused) {
        store.setMeta(INTAKE_PAUSED_KEY, now.toISOString());
        addNotice(store, "intake_paused", now);
      } else if (!reached && paused) {
        store.deleteMeta(INTAKE_PAUSED_KEY);
      }
    });
    return {};
  };
}
