import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROXY_URL,
  resolveProxyUrl,
  validateProxyUrl,
} from "./proxy-url";

describe("validateProxyUrl", () => {
  it("accepts a plain https origin and returns it unchanged", () => {
    const v = validateProxyUrl("https://relay.example.org");
    expect(v.ok).toBe(true);
    expect(v.url).toBe("https://relay.example.org");
  });

  it("normalizes spelling variants of the SAME server to one origin", () => {
    // Trailing slash, uppercase host, explicit default port, padding —
    // all must collapse to the same canonical origin the Rust side keys
    // auth state by, or one server gets several enrollment entries.
    for (const spelling of [
      "https://relay.example.org/",
      "https://RELAY.EXAMPLE.ORG",
      "https://relay.example.org:443",
      "  https://relay.example.org  ",
    ]) {
      const v = validateProxyUrl(spelling);
      expect(v.ok, spelling).toBe(true);
      expect(v.url, spelling).toBe("https://relay.example.org");
    }
  });

  it("keeps a non-default port - that is a different origin", () => {
    const v = validateProxyUrl("https://relay.example.org:8443");
    expect(v.ok).toBe(true);
    expect(v.url).toBe("https://relay.example.org:8443");
  });

  it("allows plain http ONLY for loopback dev servers", () => {
    expect(validateProxyUrl("http://localhost:8787").ok).toBe(true);
    expect(validateProxyUrl("http://127.0.0.1:8787").ok).toBe(true);
    const remote = validateProxyUrl("http://relay.example.org");
    expect(remote.ok).toBe(false);
    expect(remote.error).toMatch(/https/);
  });

  it("rejects userinfo, query, fragment, and path prefixes", () => {
    expect(validateProxyUrl("https://user:pw@relay.example.org").ok).toBe(false);
    expect(validateProxyUrl("https://relay.example.org?x=1").ok).toBe(false);
    expect(validateProxyUrl("https://relay.example.org#frag").ok).toBe(false);
    // Path prefixes would break X-Client-Sig (client signs /api/..., the
    // server would see /relay/api/...) - refused with the reason.
    const withPath = validateProxyUrl("https://relay.example.org/relay");
    expect(withPath.ok).toBe(false);
    expect(withPath.error).toMatch(/signing/);
    // A bare root slash is NOT a path prefix.
    expect(validateProxyUrl("https://relay.example.org/").ok).toBe(true);
  });

  it("rejects empty and unparseable input with readable messages", () => {
    expect(validateProxyUrl("").ok).toBe(false);
    expect(validateProxyUrl("   ").ok).toBe(false);
    expect(validateProxyUrl("not a url").ok).toBe(false);
    expect(validateProxyUrl("wallet.pwnda.org").ok).toBe(false); // no scheme
    expect(validateProxyUrl("ftp://relay.example.org").ok).toBe(false);
  });
});

describe("resolveProxyUrl precedence", () => {
  it("valid override wins over env and default", () => {
    expect(resolveProxyUrl("https://mine.example.org", "https://env.example.org")).toBe(
      "https://mine.example.org"
    );
  });

  it("invalid override is IGNORED, not fatal - env wins", () => {
    // A hand-edited store entry must not brick startup.
    expect(resolveProxyUrl("not a url", "https://env.example.org")).toBe(
      "https://env.example.org"
    );
  });

  it("env wins over the default when no override is set", () => {
    expect(resolveProxyUrl(null, "https://env.example.org")).toBe(
      "https://env.example.org"
    );
    expect(resolveProxyUrl(undefined, " https://env.example.org ")).toBe(
      "https://env.example.org"
    );
  });

  it("falls back to the production default", () => {
    expect(resolveProxyUrl(null, null)).toBe(DEFAULT_PROXY_URL);
    expect(resolveProxyUrl("", "")).toBe(DEFAULT_PROXY_URL);
  });

  it("override is returned in normalized origin form", () => {
    expect(resolveProxyUrl("https://MINE.example.org/", null)).toBe(
      "https://mine.example.org"
    );
  });
});
