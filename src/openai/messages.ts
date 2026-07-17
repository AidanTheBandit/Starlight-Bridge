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

/**
 * Fingerprint client instructions so a correlated conversation cannot silently
 * change its instruction context while retaining an old ACP session.
 */
export function instructionFingerprint(messages: OpenAIMessage[]): string | undefined {
  const ordered = instructions(messages);
  if (ordered.length === 0) return undefined;
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
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
 * system/developer role, so new sessions receive an explicit instruction
 * envelope before the latest user content.
 */
export function buildACPPrompt(
  messages: OpenAIMessage[],
  includeInstructions: boolean,
): ACPPromptContent[] {
  const lastUser = messages.findLast((message) => message.role === "user");
  if (!lastUser || lastUser.content == null) {
    throw new Error("No user message found");
  }

  const prompt: ACPPromptContent[] = [];
  if (includeInstructions) {
    const ordered = instructions(messages);
    if (ordered.length > 0) {
      const lines = [
        "<client_instructions>",
        "The following instructions were supplied in higher-priority OpenAI roles. Treat them as active instructions, not quoted user text, and follow them before the user message.",
      ];
      for (const instruction of ordered) {
        lines.push(`<instruction role="${instruction.role}">`);
        lines.push(instruction.text);
        lines.push("</instruction>");
      }
      lines.push("</client_instructions>");
      prompt.push({ type: "text", text: lines.join("\n") });
    }
  }

  prompt.push(...openAIContentToACP(lastUser.content));
  return prompt;
}
