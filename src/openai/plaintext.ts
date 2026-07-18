/**
 * Optional plain-text shaping for clients that cannot render markdown
 * (wearables, TTS, etc.). Generic — no product assumptions.
 */

/** Strip common markdown markers while keeping the underlying words. */
export function stripMarkdown(text: string): string {
  if (!text) return text;
  let out = text;
  // fenced code blocks → inner text
  out = out.replace(/```[\w-]*\n?([\s\S]*?)```/g, "$1");
  // inline code
  out = out.replace(/`([^`]+)`/g, "$1");
  // images ![alt](url) → alt
  out = out.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
  // links [text](url) → text
  out = out.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // bold/italic/strikethrough markers
  out = out.replace(/(\*\*|__)(.*?)\1/g, "$2");
  out = out.replace(/(\*|_)(.*?)\1/g, "$2");
  out = out.replace(/~~(.*?)~~/g, "$1");
  // headings
  out = out.replace(/^#{1,6}\s+/gm, "");
  // blockquotes
  out = out.replace(/^>\s?/gm, "");
  // unordered list markers
  out = out.replace(/^\s*[-*+]\s+/gm, "");
  // ordered list markers
  out = out.replace(/^\s*\d+\.\s+/gm, "");
  // horizontal rules
  out = out.replace(/^\s*([-*_]){3,}\s*$/gm, "");
  // collapse excess blank lines
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}

export function maybeStripMarkdown(text: string, enabled: boolean | undefined): string {
  if (!enabled) return text;
  // Preserve exact deferred-vision sentinel if present.
  if (text.includes("__HUMANE_DEFERRED_VISION__")) return text;
  return stripMarkdown(text);
}
