import { homedir } from "node:os"
import { join } from "node:path"
import { readFile } from "node:fs/promises"

import { streamOpenAiTextWithAuth } from "@/providers/openai/transport"

export type OpenAiAuth = {
  provider: "openai"
  method: "oauth"
  accessToken: string
  refreshToken: string
  expiresAt: number
  accountId?: string | undefined
}

export type OpenAiAuthStore = {
  openai?: OpenAiAuth | undefined
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)

  return prototype === Object.prototype || prototype === null
}

export const parseOpenAiAuthStore = (value: unknown): OpenAiAuthStore => {
  const fail = (message: string): never => {
    throw new TypeError(`Invalid OpenAI auth store: ${message}`)
  }

  if (!isPlainObject(value)) {
    return fail("expected an object")
  }

  const unexpectedStoreKey = Object.keys(value).find((key) => key !== "openai")

  if (unexpectedStoreKey !== undefined) {
    return fail(`unexpected property ${unexpectedStoreKey}`)
  }

  if (value.openai === undefined) {
    return {}
  }

  if (!isPlainObject(value.openai)) {
    return fail("openai must be an object")
  }

  const auth = value.openai
  const allowedAuthKeys = new Set([
    "provider",
    "method",
    "accessToken",
    "refreshToken",
    "expiresAt",
    "accountId",
  ])
  const unexpectedAuthKey = Object.keys(auth).find((key) => !allowedAuthKeys.has(key))

  if (unexpectedAuthKey !== undefined) {
    return fail(`unexpected openai property ${unexpectedAuthKey}`)
  }

  if (auth.provider !== "openai") {
    return fail('openai.provider must be "openai"')
  }

  if (auth.method !== "oauth") {
    return fail('openai.method must be "oauth"')
  }

  if (typeof auth.accessToken !== "string" || auth.accessToken.length === 0) {
    return fail("openai.accessToken must be a non-empty string")
  }

  if (typeof auth.refreshToken !== "string" || auth.refreshToken.length === 0) {
    return fail("openai.refreshToken must be a non-empty string")
  }

  if (
    typeof auth.expiresAt !== "number" ||
    !Number.isSafeInteger(auth.expiresAt) ||
    auth.expiresAt < 0
  ) {
    return fail("openai.expiresAt must be a non-negative safe integer")
  }

  if (
    auth.accountId !== undefined &&
    (typeof auth.accountId !== "string" || auth.accountId.length === 0)
  ) {
    return fail("openai.accountId must be a non-empty string")
  }

  return {
    openai: {
      provider: auth.provider,
      method: auth.method,
      accessToken: auth.accessToken,
      refreshToken: auth.refreshToken,
      expiresAt: auth.expiresAt,
      ...(typeof auth.accountId === "string" ? { accountId: auth.accountId } : {}),
    },
  }
}

const authFilePath = join(homedir(), ".buli", "auth.json")
//
// type OpenAiInput = []

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
  const value: unknown = JSON.parse(await readFile(authFilePath, "utf8"))

  return parseOpenAiAuthStore(value)
}

export const streamOpenAiText = async (prompt: string) => {
  const { openai: auth } = await loadAuth()

  if (!auth) {
    throw new Error("OpenAI authentication is missing")
  }

  if (auth.expiresAt <= Date.now()) {
    throw new Error("OpenAI access token has expired; sign in again")
  }

  return streamOpenAiTextWithAuth(prompt, auth)
}

if (import.meta.main) {
  try {
    const result = await streamOpenAiText("Jak mogę iterować przez obiekt w typscript")

    for await (const chunk of result.textStream) {
      process.stdout.write(chunk)
    }

    process.stdout.write("\n")
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}


class Agent {
  constructor() { }
}



// class SessionStore {
//   constructor() { }
// }
//
// class OpenAiEngine {
//   constructor() { }
//   async prompt(prompt: string) { }
// }
//
// class Runtime {
//   constructor(private engine: OpenAiEngine) { }
//
//   async submit(prompt: string, sessionId: string) {
//     await this.engine.prompt(prompt)
//   }
// }
//
// class OpenAiDriver { }
//
//
