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

test("shares one provider disposal and keeps the first reason", async () => {
  const disposeFinished = Promise.withResolvers<void>()
  const firstReason = new Error("first shutdown")
  let disposeCount = 0
  let didReenter = false
  let observedReason: unknown
  let reentrantDispose: Promise<void> | undefined
  let service: AuthenticationService
  const provider = authenticationProvider({
    dispose: async (reason) => {
      disposeCount += 1
      observedReason = reason
      if (!didReenter) {
        didReenter = true
        reentrantDispose = service.dispose(new Error("reentrant shutdown"))
      }
      await disposeFinished.promise
    },
  })
  service = new AuthenticationService([provider])

  const firstDispose = service.dispose(firstReason)
  const secondDispose = service.dispose(new Error("ignored shutdown"))

  expect(reentrantDispose).toBe(firstDispose)
  expect(secondDispose).toBe(firstDispose)
  expect(disposeCount).toBe(1)
  expect(observedReason).toBe(firstReason)

  disposeFinished.resolve()
  await firstDispose
  expect(service.dispose()).toBe(firstDispose)
  expect(disposeCount).toBe(1)
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
