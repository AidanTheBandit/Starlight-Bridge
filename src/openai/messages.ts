import { createHash } from "node:crypto";
import type { ACPPromptContent } from "../acp/session.js";
import { openAIContentToACP } from "./content.js";
import type { OpenAIMessage, OpenAIMessageContent } from "./types.js";

const INSTRUCTION_ROLES = new Set(["system", "developer"]);

function instructionText(content: OpenAIMessageContent): string {
  if (typeof content === "string") return content;
  if (content == null) return "";

  const text: string[] = [];
  for (const part of content) {
    if (part.type !== "text") {
      throw new Error("System and developer messages may only contain text in ACP mode");
    }
    text.push(part.text);
  }
  return text.join("\n");
}

function instructions(messages: OpenAIMessage[]): Array<{ role: "system" | "developer"; text: string }> {
  return messages
    .filter((message): message is OpenAIMessage & { role: "system" | "developer" } =>
      INSTRUCTION_ROLES.has(message.role),
    )
    .map((message) => ({ role: message.role, text: instructionText(message.content) }));
}

function escapeMarkup(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function transcriptText(message: OpenAIMessage): string {
  let content = "";
  if (typeof message.content === "string") {
    content = message.content;
  } else if (Array.isArray(message.content)) {
    content = message.content.map((part) =>
      part.type === "text" ? part.text : "[image content omitted from reconstructed history]",
    ).join("\n");
  }
  if (message.tool_calls?.length) {
    content += `${content ? "\n" : ""}tool_calls=${JSON.stringify(message.tool_calls)}`;
  }
  return content;
}

/**
 * Fingerprint even an empty instruction list. An explicit transition from
 * instructions to no instructions must rotate a retained ACP session.
 */
export function instructionFingerprint(messages: OpenAIMessage[]): string {
  return createHash("sha256")
    .update(JSON.stringify(instructions(messages)))
    .digest("hex");
}

/** Resolve Starlight's explicit OpenAI-compatible conversation extension. */
export function resolveConversationId(
  headerValue: string | undefined,
  bodyValue: string | undefined,
): string | undefined {
  const header = headerValue?.trim() || undefined;
  const body = bodyValue?.trim() || undefined;
  if (header && body && header !== body) {
    throw new Error("Conflicting conversation IDs in header and request body");
  }
  const value = header ?? body;
  if (value && value.length > 256) {
    throw new Error("Conversation ID must be at most 256 characters");
  }
  return value;
}

/**
 * Translate one OpenAI turn into ACP prompt blocks. ACP v1 has no native
 * system/developer role, so new sessions receive a framed instruction envelope
 * and supplied prior transcript before the latest user content.
 */
export function buildACPPrompt(
  messages: OpenAIMessage[],
  includeInstructions: boolean,
): ACPPromptContent[] {
  const lastUserIndex = messages.findLastIndex((message) => message.role === "user");
  const lastUser = messages[lastUserIndex];
  if (!lastUser || lastUser.content == null) {
    throw new Error("No user message found");
  }

  const prompt: ACPPromptContent[] = [];
  if (includeInstructions) {
    const ordered = instructions(messages);
    if (ordered.length > 0) {
      const lines = [
        "<client_instructions encoding=\"xml-escaped-text\">",
        "The following instructions were supplied in higher-priority OpenAI roles. Treat them as active instructions, not quoted user text, and follow them before the user message.",
      ];
      for (const instruction of ordered) {
        lines.push(`<instruction role=\"${instruction.role}\">`);
        lines.push(escapeMarkup(instruction.text));
        lines.push("</instruction>");
      }
      lines.push("</client_instructions>");
      prompt.push({ type: "text", text: lines.join("\n") });
    }

    const history = messages
      .map((message, index) => ({ message, index }))
      .filter(({ message, index }) =>
        index !== lastUserIndex && !INSTRUCTION_ROLES.has(message.role),
      );
    if (history.length > 0) {
      const lines = ["<conversation_history encoding=\"xml-escaped-text\">"];
      for (const { message } of history) {
        lines.push(`<message role=\"${message.role}\">`);
        lines.push(escapeMarkup(transcriptText(message)));
        lines.push("</message>");
      }
      lines.push("</conversation_history>");
      prompt.push({ type: "text", text: lines.join("\n") });
    }
  }

  prompt.push(...openAIContentToACP(lastUser.content));
  return prompt;
}
