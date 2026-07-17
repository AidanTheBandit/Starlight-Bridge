import { describe, expect, it } from "vitest";
import { openAIContentToACP } from "../src/openai/content.js";
import { ACPSession } from "../src/acp/session.js";

describe("OpenAI multimodal content translation", () => {
  it("converts text and a base64 data image into ACP content blocks", () => {
    const blocks = openAIContentToACP([
      { type: "text", text: "What is in front of me?" },
      {
        type: "image_url",
        image_url: {
          url: "data:image/jpeg;base64,/9j/AA==",
          detail: "auto",
        },
      },
    ]);

    expect(blocks).toEqual([
      { type: "text", text: "What is in front of me?" },
      { type: "image", mimeType: "image/jpeg", data: "/9j/AA==" },
    ]);
  });

  it("passes translated blocks unchanged to session/prompt", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const client = {
      onNotification: () => () => {},
      rpc: async (method: string, params: unknown) => {
        calls.push({ method, params });
        return { stopReason: "end_turn" };
      },
    };
    const session = new ACPSession("session-1", client as never);
    const blocks = [
      { type: "text" as const, text: "Describe this image" },
      { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgo=" },
    ];

    await session.prompt(blocks);

    expect(calls[0]).toEqual({
      method: "session/prompt",
      params: { sessionId: "session-1", prompt: blocks },
    });
  });
});
