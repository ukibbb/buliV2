import { expect, test } from "bun:test";

import { parseOpenAiAuthStore, streamOpenAiText } from "@/providers";
import { OpenAiProvider } from "@/providers/openai";
import { OPENAI_CODEX_API_ENDPOINT, OPENAI_CODEX_CLIENT_VERSION } from "@/providers/openai/constants";
import { streamOpenAiTextWithAuth } from "@/providers/openai/transport";

const validAuthWithoutAccountId = {
  provider: "openai",
  method: "oauth",
  accessToken: "access-token",
  refreshToken: "refresh-token",
  expiresAt: 1,
} as const;

const validAuth = {
  ...validAuthWithoutAccountId,
  accountId: "account-id",
};

test("@/providers exposes its module entry points", () => {
  expect(streamOpenAiText).toBeDefined();
  expect(OpenAiProvider).toBeDefined();
});

test("parses OpenAI authentication", () => {
  expect(parseOpenAiAuthStore({})).toEqual({});
  expect(parseOpenAiAuthStore({ openai: validAuthWithoutAccountId })).toEqual({
    openai: validAuthWithoutAccountId,
  });
  expect(parseOpenAiAuthStore({ openai: validAuth })).toEqual({ openai: validAuth });
});

test("rejects invalid OpenAI authentication", () => {
  const invalidStores: unknown[] = [
    null,
    [],
    new Date(),
    { unexpected: true },
    { "": true },
    { openai: null },
    { openai: { ...validAuth, unexpected: true } },
    { openai: { ...validAuth, "": true } },
    { openai: { ...validAuth, provider: "other" } },
    { openai: { ...validAuth, method: "api-key" } },
    { openai: { ...validAuth, accessToken: "" } },
    { openai: { ...validAuth, refreshToken: "" } },
    { openai: { ...validAuth, expiresAt: -1 } },
    { openai: { ...validAuth, expiresAt: 1.5 } },
    { openai: { ...validAuth, expiresAt: Number.MAX_SAFE_INTEGER + 1 } },
    { openai: { ...validAuth, accountId: "" } },
  ];

  for (const store of invalidStores) {
    expect(() => parseOpenAiAuthStore(store)).toThrow(TypeError);
  }
});

test("streams through the ChatGPT Codex endpoint with OAuth headers", async () => {
  let capturedRequest: Request | undefined;
  const captureFetch = Object.assign(
    async (...args: Parameters<typeof globalThis.fetch>) => {
      capturedRequest = new Request(...args);

      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
    {
      preconnect: globalThis.fetch.preconnect,
    },
  );

  const result = streamOpenAiTextWithAuth(
    "Hello from Buli",
    {
      accessToken: "test-access-token",
      accountId: "test-account-id",
    },
    captureFetch,
  );

  await result.consumeStream();

  if (!capturedRequest) {
    throw new Error("Expected the OpenAI SDK to issue a request");
  }

  expect(capturedRequest.url).toBe(OPENAI_CODEX_API_ENDPOINT);
  expect(capturedRequest.headers.get("authorization")).toBe("Bearer test-access-token");
  expect(capturedRequest.headers.get("chatgpt-account-id")).toBe("test-account-id");
  expect(capturedRequest.headers.get("originator")).toBe("buli");
  expect(capturedRequest.headers.get("version")).toBe(OPENAI_CODEX_CLIENT_VERSION);

  const body = (await capturedRequest.json()) as Record<string, unknown>;

  expect(body.model).toBe("gpt-5.6-sol");
  expect(body.store).toBe(false);
  expect(body.stream).toBe(true);
  expect(JSON.stringify(body.input)).toContain("Hello from Buli");
});
