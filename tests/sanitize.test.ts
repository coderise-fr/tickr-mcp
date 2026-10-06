import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cleanDescription, cleanDetail, cleanName } from "../src/sanitize.js";

const INVISIBLE = [
  "\u200B", "\u200C", "\u200D", "\u200E", "\u200F",
  "\u202A", "\u202B", "\u202C", "\u202D", "\u202E",
  "\u2060", "\u2061", "\u2062", "\u2063", "\u2064",
  "\u2066", "\u2067", "\u2068", "\u2069",
  "\uFEFF",
  "\u061C", "\u180E",
];

describe("invisible formatting characters", () => {
  it.each(INVISIBLE.map((c) => [`U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`, c]))(
    "%s is stripped from names, descriptions and details",
    (_label, c) => {
      expect(cleanName(`Pro${c}ject`)).toBe("Project");
      expect(cleanDescription(`line1${c}\nline2`)).toBe("line1\nline2");
      expect(cleanDetail(`de${c}tail`)).toBe("detail");
    },
  );

  it("keeps the neighbouring characters that are not formatting characters", () => {
    expect(cleanName("\u2065\u2070\u2010é")).toBe("\u2065\u2070\u2010é");
  });

  it("hides a right-to-left override that would reverse what a human reads", () => {
    expect(cleanName("invoice\u202Etxt.exe")).toBe("invoicetxt.exe");
  });
});

describe("source files", () => {
  it("have no byte order mark and end with a newline", () => {
    const dir = new URL("../src/", import.meta.url);
    const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(new URL(f.replaceAll("\\", "/"), dir), "utf8");
      expect(text.charCodeAt(0), f).not.toBe(0xfeff);
      expect(text.endsWith("\n"), f).toBe(true);
    }
  });
});
