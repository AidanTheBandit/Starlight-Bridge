import { describe, expect, it } from "vitest";
import { stripMarkdown, maybeStripMarkdown } from "../src/openai/plaintext.js";

describe("stripMarkdown", () => {
  it("removes common markdown markers", () => {
    const input = "## Hello\n\nThis is **bold** and *italic* with `code` and a [link](https://x.test).\n\n- one\n- two";
    const out = stripMarkdown(input);
    expect(out).toContain("Hello");
    expect(out).toContain("bold");
    expect(out).not.toContain("**");
    expect(out).not.toContain("##");
    expect(out).not.toContain("`");
    expect(out).not.toContain("https://x.test");
  });

  it("preserves deferred vision marker when strip is enabled", () => {
    const marker = "prefix __HUMANE_DEFERRED_VISION__ suffix";
    expect(maybeStripMarkdown(marker, true)).toBe(marker);
  });

  it("is a no-op when disabled", () => {
    expect(maybeStripMarkdown("**x**", false)).toBe("**x**");
  });
});
