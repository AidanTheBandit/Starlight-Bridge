import { describe, expect, it, vi } from "vitest";
import { buildPinTools } from "../src/mcp/pin-tools.js";

describe("request_pin_camera", () => {
  it("returns the deferred marker immediately without waiting for a frame", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const tool = buildPinTools().find((entry) => entry.name === "request_pin_camera");

    expect(tool).toBeDefined();
    expect(tool?.inputSchema.properties).not.toHaveProperty("wait");
    expect(tool?.inputSchema.properties).not.toHaveProperty("timeout_secs");

    const started = performance.now();
    const result = await tool!.handler({ question: "What is in front of me?" });
    const elapsedMs = performance.now() - started;

    expect(elapsedMs).toBeLessThan(100);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "deferred_vision_requested",
      question: "What is in front of me?",
      deferred_vision_marker: "__HUMANE_DEFERRED_VISION__",
    });

    fetchSpy.mockRestore();
  });
});
