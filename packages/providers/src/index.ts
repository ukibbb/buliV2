import { homedir } from "node:os"
import { join } from "node:path"
import { readFile } from "node:fs/promises"

import {
  OPENAI_CODEX_CLIENT_VERSION,
  OPENAI_CODEX_MODELS_ENDPOINT,
} from "./openai/constants";


import { z } from "zod";

export const OpenAiAuthSchema = z
  .object({
    provider: z.literal("openai"),
    method: z.literal("oauth"),
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1),
    expiresAt: z.number().int().nonnegative(),
    accountId: z.string().min(1).optional(),
  })
  .strict();

export const OpenAiAuthStoreSchema = z
  .object({
    openai: OpenAiAuthSchema.optional(),
  })
  .strict();

export type OpenAiAuth = z.infer<typeof OpenAiAuthSchema>;
export type OpenAiAuthStore = z.infer<typeof OpenAiAuthStoreSchema>;

const OpenAiModelsResponseSchema = z.object({
  models: z.array(
    z
      .object({
        slug: z.string(),
        display_name: z.string(),
        visibility: z.enum(["list", "hide", "none"]),
        priority: z.number(),
      })
      .passthrough(),
  ),
});

const authFilePath = join(homedir(), ".buli", "auth.json")

type OpenAiInput = []

// type OpenAiRequest = {
//   model: string
//   instructions: string
//   store: boolean
//   input: OpenAiInput
//   tools: OpenAiTools
//   reasoning: OpenAiResoning
//   stream: boolean
// }


const loadAuth = async (): Promise<OpenAiAuthStore> => {
  return OpenAiAuthStoreSchema.parse(JSON.parse(await readFile(authFilePath, "utf8")))
}

export const loadOpenAiModels = async () => {
  const { openai } = await loadAuth()

  if (!openai) {
    throw new Error("OpenAI authentication is missing")
  }

  if (openai.expiresAt <= Date.now()) {
    throw new Error("OpenAI access token has expired; sign in again")
  }

  const url = new URL(OPENAI_CODEX_MODELS_ENDPOINT)
  url.searchParams.set("client_version", OPENAI_CODEX_CLIENT_VERSION)

  const headers = new Headers({
    Authorization: `Bearer ${openai.accessToken}`,
    version: OPENAI_CODEX_CLIENT_VERSION,
    originator: "buli",
  })

  if (openai.accountId) {
    headers.set("ChatGPT-Account-ID", openai.accountId)
  }

  const response = await fetch(url, { headers, method: "GET" })
  const responseBody = await response.text()

  if (!response.ok) {
    throw new Error(`Failed to load Codex models (${response.status}): ${responseBody}`)
  }

  return OpenAiModelsResponseSchema.parse(JSON.parse(responseBody)).models
}

if (import.meta.main) {
  loadOpenAiModels()
    .then((models) =>
      console.log(
        "MODELS",
        models.filter((model) => model.visibility === "list").map((model) => model.slug),
      ),
    )
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
}
