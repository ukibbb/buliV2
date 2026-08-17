import { expect, test } from "bun:test"

import { AuthenticationService } from "@/auth/authentication-service"
import type { IAuthenticationProvider } from "@/auth/types"

test("keeps a provider available for login when stored status is invalid", async () => {
  const provider = authenticationProvider({
    status: async () => {
      throw new Error("Stored credential is malformed")
    },
  })
  const service = new AuthenticationService([provider])

  expect(await service.listProviders()).toEqual([{
    providerId: "openai",
    name: "OpenAI / ChatGPT",
    connected: false,
    statusError: "Authentication status is unavailable",
    methods: [{
      id: "browser",
      name: "Browser login",
      description: "Sign in with ChatGPT",
    }],
  }])
})

test("rejects duplicate provider IDs", () => {
  const provider = authenticationProvider()
  expect(() => new AuthenticationService([provider, provider])).toThrow(
    "provider IDs must be unique",
  )
})

function authenticationProvider(
  overrides: Partial<IAuthenticationProvider> = {},
): IAuthenticationProvider {
  return {
    id: "openai",
    name: "OpenAI / ChatGPT",
    methods: [{
      id: "browser",
      name: "Browser login",
      description: "Sign in with ChatGPT",
    }],
    status: async () => ({
      providerId: "openai",
      connected: false,
    }),
    login: async () => ({
      providerId: "openai",
      connected: true,
    }),
    logout: async () => false,
    ...overrides,
  }
}
