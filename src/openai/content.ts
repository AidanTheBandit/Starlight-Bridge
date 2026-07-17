import type { OpenAIMessageContent } from "./types.js";
import type { ACPPromptContent } from "../acp/session.js";

/** Convert OpenAI chat content into ACP prompt content blocks. */
export function openAIContentToACP(content: OpenAIMessageContent): ACPPromptContent[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  if (!Array.isArray(content) || content.length === 0) {
    throw new Error("User message content must contain text or an image");
  }

  return content.map((part): ACPPromptContent => {
    if (part.type === "text") {
      return { type: "text", text: part.text };
    }

    if (part.type === "image_url") {
      const url = typeof part.image_url === "string"
        ? part.image_url
        : part.image_url.url;
      const comma = url.indexOf(",");
      const header = comma >= 0 ? url.slice(0, comma) : "";
      if (!header.startsWith("data:") || !header.endsWith(";base64")) {
        throw new Error("ACP mode currently requires image_url to use a base64 data URL");
      }

      const mimeType = header.slice(5).split(";", 1)[0];
      const data = url.slice(comma + 1);
      if (!mimeType.startsWith("image/") || data.length === 0) {
        throw new Error("Invalid image data URL");
      }

      return { type: "image", mimeType, data };
    }

    throw new Error(`Unsupported OpenAI content part: ${(part as { type?: string }).type ?? "unknown"}`);
  });
}
