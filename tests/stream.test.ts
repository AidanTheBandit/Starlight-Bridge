import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let completion: Promise<void> = Promise.resolve();
  return {
    write: vi.fn(async (_data: string) => {}),
    markIdle: vi.fn(),
    setCompletion(value: Promise<void>) {
      completion = value;
    },
    completion() {
      return completion;
    },
  };
});

vi.mock("hono/streaming", () => ({
  stream: (_context: unknown, callback: (writer: { write(data: string): Promise<void> }) => Promise<void>) => {
    mocks.setCompletion(Promise.resolve(callback({ write: mocks.write })));
    return new Response();
  },
}));

vi.mock("../src/acp/manager.js", () => ({
  markIdle: mocks.markIdle,
}));

const { streamACPToOpenAI } = await import("../src/openai/stream.js");

async function run(
  prompt: (content: unknown, onChunk?: (chunk: string) => Promise<void>) => Promise<string>,
  onSessionError = vi.fn(async () => {}),
) {
  const onComplete = vi.fn(async () => {});
  await streamACPToOpenAI(
    {} as never,
    { prompt, dispose: vi.fn(async () => {}) } as never,
    [{ type: "text", text: "hello" }],
    "hermes-default",
    { mcp: { cleanup_after_request: false } } as never,
    "hermes",
    false,
    onSessionError,
    onComplete,
  );
  await mocks.completion();
  return { onSessionError, onComplete };
}

describe("stream session invalidation", () => {
  beforeEach(() => {
    mocks.write.mockReset();
    mocks.write.mockResolvedValue(undefined);
    mocks.markIdle.mockClear();
  });

  it("keeps initial SSE write failures local", async () => {
    mocks.write.mockRejectedValueOnce(new Error("disconnected"));
    const prompt = vi.fn(async () => "");
    const { onSessionError, onComplete } = await run(prompt);
    expect(prompt).not.toHaveBeenCalled();
    expect(onSessionError).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("keeps content SSE write failures local", async () => {
    mocks.write
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("disconnected"));
    const prompt = vi.fn(async (_content: unknown, onChunk?: (chunk: string) => Promise<void>) => {
      await onChunk?.("partial");
      return "partial";
    });
    const { onSessionError } = await run(prompt);
    expect(onSessionError).not.toHaveBeenCalled();
  });

  it("keeps final SSE write failures local", async () => {
    mocks.write
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("disconnected"));
    const { onSessionError } = await run(async () => "done");
    expect(onSessionError).not.toHaveBeenCalled();
  });

  it("invalidates only when the ACP prompt fails", async () => {
    const onSessionError = vi.fn(async () => {});
    const result = await run(async () => {
      throw new Error("ACP process exited");
    }, onSessionError);
    expect(result.onSessionError).toHaveBeenCalledOnce();
    expect(mocks.write).toHaveBeenCalledTimes(3);
  });
});
