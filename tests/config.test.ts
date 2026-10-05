import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_BASE_URL, loadConfig } from "../src/config.js";

const KEY = "tkr_secret_value";

describe("loadConfig", () => {
  it("requires TICKR_API_KEY", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ TICKR_API_KEY: "   " })).toThrow(/TICKR_API_KEY/);
  });

  it("defaults the base URL", () => {
    expect(loadConfig({ TICKR_API_KEY: KEY })).toEqual({ apiKey: KEY, baseUrl: DEFAULT_BASE_URL });
  });

  it("removes trailing slashes and keeps a path prefix", () => {
    expect(loadConfig({ TICKR_API_KEY: KEY, TICKR_BASE_URL: "https://t.example.com/tickr//" }).baseUrl)
      .toBe("https://t.example.com/tickr");
  });

  it.each(["http://localhost:5002", "http://127.0.0.1:5002", "http://[::1]:5002"])("allows http for %s", (url) => {
    expect(loadConfig({ TICKR_API_KEY: KEY, TICKR_BASE_URL: url }).baseUrl).toBe(url);
  });

  it.each([
    ["http://tickr.example.com", /https/],
    ["ftp://tickr.example.com", /https/],
    ["https://user:pass@tickr.example.com", /credentials/],
    ["https://tickr.example.com/?x=1", /query/],
    ["not a url", /valid URL/],
  ])("rejects %s", (url, message) => {
    expect(() => loadConfig({ TICKR_API_KEY: KEY, TICKR_BASE_URL: url })).toThrow(message);
  });

  it("never echoes the key or the raw URL in errors", () => {
    // Check credentials case
    expect(() =>
      loadConfig({ TICKR_API_KEY: KEY, TICKR_BASE_URL: "https://user:pass@x.example.com" })
    ).toThrow(ConfigError);

    try {
      loadConfig({ TICKR_API_KEY: KEY, TICKR_BASE_URL: "https://user:pass@x.example.com" });
    } catch (e) {
      const msg = String((e as Error).message);
      expect(msg).not.toContain("pass");
      expect(msg).not.toContain("user");
      expect(msg).not.toContain(KEY);
      expect(msg).not.toContain("x.example.com");
    }

    // Check garbage URL case with key-like text
    expect(() =>
      loadConfig({ TICKR_API_KEY: KEY, TICKR_BASE_URL: "not a url tkr_secret_value" })
    ).toThrow(ConfigError);

    try {
      loadConfig({ TICKR_API_KEY: KEY, TICKR_BASE_URL: "not a url tkr_secret_value" });
    } catch (e) {
      const msg = String((e as Error).message);
      expect(msg).not.toContain("tkr_secret_value");
      expect(msg).not.toContain("not a url");
    }
  });
});
