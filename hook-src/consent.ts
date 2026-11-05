// Consent to a checkout's .tickr.json. A .tickr.json can arrive with a clone or a pull, written by
// someone else: without a check it would send this machine's session time to a project of that
// person's choosing. A mapping therefore tracks nothing until /tickr:link (or `accept`) has
// recorded, on THIS machine, that the user linked this very checkout with this very content.
//
// A link key is <checkout tag>-<link hash>: the checkout tag is the first 32 hex digits of the
// SHA-256 of the checkout directory's real path, the link hash the SHA-256 of that path and the
// mapping's hash. Each link is one empty file <plugin data>/linked/<key>: links are written
// independently (two `accept` at once never lose one), and a link exists iff its file does.
// Changing the file (a pull, an edit) or moving the checkout makes the link void until the user
// links again. Revoking a link stops the sessions already recorded under it (the flusher checks
// the link of each session's last event): deleting its file, or a hook of the same checkout that
// finds another, unlinked content (revokeStaleLinks, the reason for the checkout tag). The files
// hold nothing but their name: no path, no id.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Directory of the link files, inside the plugin data directory. */
export const LINKS_DIR = "linked";
/** Links kept at most (the least recently linked are dropped, best effort). */
export const MAX_LINKS = 500;

const KEY_PATTERN = /^[0-9a-f]{32}-[0-9a-f]{64}$/;
const TAG_LENGTH = 32;

function realDir(dir: string): string {
  try {
    return realpathSync.native(dir);
  } catch {
    return dir;
  }
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** The link key of a checkout directory and a mapping hash. */
export function linkKey(mappingDir: string, mappingHash: string): string {
  const dir = realDir(mappingDir);
  return `${sha256(JSON.stringify([dir])).slice(0, TAG_LENGTH)}-${sha256(JSON.stringify([dir, mappingHash]))}`;
}

/** True when the link of this key exists on this machine (one file check). */
export function isLinkKeyActive(dataDir: string, key: string): boolean {
  return KEY_PATTERN.test(key) && existsSync(join(dataDir, LINKS_DIR, key));
}

/** True when this checkout and mapping content were linked on this machine. */
export function isLinked(dataDir: string, mappingDir: string, mappingHash: string): boolean {
  return isLinkKeyActive(dataDir, linkKey(mappingDir, mappingHash));
}

/** Drops the least recently linked files beyond MAX_LINKS, never `keep`. Errors are ignored. */
function pruneLinks(dir: string, keep: string): void {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => KEY_PATTERN.test(n));
  } catch {
    return;
  }
  if (names.length <= MAX_LINKS) return;
  const dated = names
    .filter((n) => n !== keep)
    .map((n) => {
      try {
        return { n, t: statSync(join(dir, n)).mtimeMs };
      } catch {
        return { n, t: 0 };
      }
    })
    .sort((a, b) => a.t - b.t || (a.n < b.n ? -1 : 1));
  for (const { n } of dated.slice(0, names.length - MAX_LINKS)) {
    try {
      unlinkSync(join(dir, n));
    } catch {
      // Removed meanwhile, or not removable: the cap is best effort.
    }
  }
}

/**
 * The checkout's .tickr.json is not linked (a hook found it so): its links made for another
 * content are revoked, so that the flusher stops the sessions recorded under them. Errors are ignored.
 */
export function revokeStaleLinks(dataDir: string, mappingDir: string, mappingHash: string): void {
  const key = linkKey(mappingDir, mappingHash);
  const tag = key.slice(0, TAG_LENGTH + 1);
  const dir = join(dataDir, LINKS_DIR);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === key || !name.startsWith(tag) || !KEY_PATTERN.test(name)) continue;
    try {
      unlinkSync(join(dir, name));
    } catch {
      // Removed meanwhile, or not removable: the next hook tries again.
    }
  }
}

/** Records the link; false when it could not be written. */
export function recordLink(dataDir: string, mappingDir: string, mappingHash: string): boolean {
  const key = linkKey(mappingDir, mappingHash);
  const dir = join(dataDir, LINKS_DIR);
  const file = join(dir, key);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, "", { flag: "w" });
  } catch {
    return false;
  }
  try {
    // Linking again makes the link the most recent one (truncating an empty file may keep its mtime).
    const now = new Date();
    utimesSync(file, now, now);
  } catch {
    // The link exists; only its age is off.
  }
  pruneLinks(dir, key);
  return true;
}
