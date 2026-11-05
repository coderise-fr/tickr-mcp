// Identifiers: ULID for local event ids (monotonic within a process), UUIDv7 for segment ids.
import { randomBytes } from "node:crypto";

export type RandomBytes = (n: number) => Buffer;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_TIME = 2 ** 48 - 1;

function timeBytes(nowMs: number): number[] {
  let ms = Math.min(Math.max(Math.floor(nowMs), 0), MAX_TIME);
  const bytes = new Array<number>(6);
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  return bytes;
}

function hex(bytes: ArrayLike<number>): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** RFC 9562 UUID version 7: 48-bit Unix milliseconds, then 74 random bits. */
export function uuidv7(nowMs: number, rand: RandomBytes = randomBytes): string {
  const bytes = new Uint8Array(16);
  bytes.set(timeBytes(nowMs), 0);
  bytes.set(rand(10).subarray(0, 10), 6);
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const h = hex(bytes);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function encodeTime(ms: number): string {
  let rest = ms;
  let text = "";
  for (let i = 0; i < 10; i++) {
    text = CROCKFORD[rest % 32]! + text;
    rest = Math.floor(rest / 32);
  }
  return text;
}

/** 80 random bits as 16 base-32 digits (most significant first). */
function randomDigits(rand: RandomBytes): number[] {
  const bytes = rand(10);
  const digits: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < 10; i++) {
    buffer = (buffer << 8) | bytes[i]!;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      digits.push((buffer >> bits) & 31);
    }
    buffer &= (1 << bits) - 1;
  }
  return digits;
}

/** Adds one to the digits in place; false when they were all at the maximum. */
function increment(digits: number[]): boolean {
  for (let i = digits.length - 1; i >= 0; i--) {
    if (digits[i]! < 31) {
      digits[i]! += 1;
      return true;
    }
    digits[i] = 0;
  }
  return false;
}

let lastMs = -1;
let lastDigits: number[] = [];

/**
 * ULID (Crockford base 32, 48-bit time + 80 random bits). Monotonic within the process: in the
 * same millisecond, or when the clock went back, the previous random part is incremented.
 */
export function ulid(nowMs: number, rand: RandomBytes = randomBytes): string {
  let ms = Math.min(Math.max(Math.floor(nowMs), 0), MAX_TIME);
  if (ms <= lastMs) {
    ms = lastMs;
    if (!increment(lastDigits)) {
      ms = Math.min(lastMs + 1, MAX_TIME);
      lastDigits = randomDigits(rand);
    }
  } else {
    lastDigits = randomDigits(rand);
  }
  lastMs = ms;
  return encodeTime(ms) + lastDigits.map((d) => CROCKFORD[d]).join("");
}
