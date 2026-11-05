import { describe, expect, it } from "vitest";
import { ulid, uuidv7 } from "../../hook-src/ids.js";

const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function fixed(byte: number) {
  return (n: number) => Buffer.alloc(n, byte);
}

describe("uuidv7", () => {
  it("uuidv7 has version 7 and variant bits and sorts by time", () => {
    const id = uuidv7(Date.UTC(2026, 10, 5, 10, 0, 0));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    // The variant and version bits are forced whatever the random bytes are.
    expect(uuidv7(0, fixed(0xff))).toBe("00000000-0000-7fff-bfff-ffffffffffff");
    expect(uuidv7(0, fixed(0x00))).toBe("00000000-0000-7000-8000-000000000000");

    // The first 48 bits are the Unix time in milliseconds, big-endian.
    const ms = 0x0123456789ab;
    expect(uuidv7(ms, fixed(0)).replace(/-/g, "").slice(0, 12)).toBe("0123456789ab");

    const times = [1, 2, 1000, 1_700_000_000_000, 1_800_000_000_000, 2 ** 48 - 1];
    const ids = times.map((t) => uuidv7(t, fixed(0xff)));
    expect([...ids].sort()).toEqual(ids);
    const randomFirst = times.map((t, i) => uuidv7(t, fixed(i % 2 ? 0x00 : 0xff)));
    expect([...randomFirst].sort()).toEqual(randomFirst);
  });

  it("uses fresh random bytes by default", () => {
    const now = Date.now();
    expect(uuidv7(now)).not.toBe(uuidv7(now));
  });
});

describe("ulid", () => {
  it("encodes the time in the first 10 Crockford base32 characters", () => {
    const id = ulid(1_469_918_176_385, fixed(0));
    expect(id).toMatch(CROCKFORD);
    expect(id.slice(0, 10)).toBe("01ARYZ6S41");
  });

  it("ulid is monotonic within one millisecond", () => {
    const now = 1_800_000_000_000;
    const ids = Array.from({ length: 1000 }, () => ulid(now));
    for (const id of ids) expect(id).toMatch(CROCKFORD);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });

  it("stays monotonic when the random part would have gone down, or the clock went back", () => {
    const now = 1_800_000_000_100;
    const first = ulid(now, fixed(0x7f));
    const second = ulid(now, fixed(0x00));
    const third = ulid(now - 50, fixed(0x00));
    expect(first < second).toBe(true);
    expect(second < third).toBe(true);
  });

  it("sorts by time across milliseconds", () => {
    const a = ulid(1_800_000_001_000, fixed(0xff));
    const b = ulid(1_800_000_001_001, fixed(0x00));
    expect(a < b).toBe(true);
  });
});
