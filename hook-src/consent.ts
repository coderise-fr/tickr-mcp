// Consent to a checkout's .tickr.json. A .tickr.json can arrive with a clone or a pull, written by
// someone else: without a check it would send this machine's session time to a project of that
// person's choosing. A mapping therefore tracks nothing until /tickr:link (or `accept`) has
// recorded, on THIS machine, that the user linked this very checkout with this very content.
//
// A link is the SHA-256 of the checkout directory's real path and the mapping's hash, kept in
// <plugin data>/linked.json. Changing the file (a pull, an edit) or moving the checkout makes the
// link void until the user links again. The file holds hashes only: no path, no id.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LINKED_FILE = "linked.json";
/** Links kept at most (the oldest are dropped). */
export const MAX_LINKS = 500;

function realDir(dir: string): string {
  try {
    return realpathSync.native(dir);
  } catch {
    return dir;
  }
}

/** The link of a checkout directory and a mapping hash. */
export function linkKey(mappingDir: string, mappingHash: string): string {
  return createHash("sha256").update(JSON.stringify([realDir(mappingDir), mappingHash]), "utf8").digest("hex");
}

function readLinks(dataDir: string): string[] {
  try {
    const doc = JSON.parse(readFileSync(join(dataDir, LINKED_FILE), "utf8")) as { links?: unknown } | null;
    return Array.isArray(doc?.links) ? doc.links.filter((l): l is string => typeof l === "string") : [];
  } catch {
    return [];
  }
}

/** True when this checkout and mapping content were linked on this machine. */
export function isLinked(dataDir: string, mappingDir: string, mappingHash: string): boolean {
  return readLinks(dataDir).includes(linkKey(mappingDir, mappingHash));
}

/** Records the link (atomically); false when it could not be written. */
export function recordLink(dataDir: string, mappingDir: string, mappingHash: string): boolean {
  const key = linkKey(mappingDir, mappingHash);
  const temp = join(dataDir, `.${LINKED_FILE}.${process.pid}.tmp`);
  try {
    mkdirSync(dataDir, { recursive: true });
    const links = readLinks(dataDir).filter((l) => l !== key);
    links.push(key);
    writeFileSync(temp, JSON.stringify({ version: 1, links: links.slice(-MAX_LINKS) }), { flag: "w" });
    renameSync(temp, join(dataDir, LINKED_FILE));
    return true;
  } catch {
    try {
      unlinkSync(temp);
    } catch {
      // Already gone.
    }
    return false;
  }
}
