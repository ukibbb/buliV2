import { expect, test } from "bun:test";

import { loadOpenAiModels } from "@buli/providers";
import { OpenAiProvider } from "@buli/providers/openai";

test("@buli/providers exposes its package entry points", () => {
  expect(loadOpenAiModels).toBeDefined();
  expect(OpenAiProvider).toBeDefined();
});
