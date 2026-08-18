import { expect, test } from "bun:test"

import type {
  IAuthProviderInfo,
  IAuthenticationService,
} from "@/auth/contracts"
import { AuthenticationFlowController } from "@/tui/authentication/authentication-flow-controller"
import type { TAuthenticationOutcome } from "@/tui/authentication/types"

const PROVIDER: IAuthProviderInfo = {
  providerId: "openai",
  name: "OpenAI / ChatGPT",
  connected: false,
  methods: [{
    id: "browser",
    name: "Browser login",
    description: "Sign in in a browser",
  }],
}

test("closes an authentication flow exactly once", () => {
  const outcomes: TAuthenticationOutcome[] = []
  const controller = createController(authenticationService(), (outcome) => {
    outcomes.push(outcome)
  })

  controller.close()
  controller.close("success")
  controller.cancel()

  expect(outcomes).toEqual(["cancelled"])
})

test("dispose aborts provider loading and ignores its late result", async () => {
  const providers = Promise.withResolvers<readonly IAuthProviderInfo[]>()
  let loadSignal: AbortSignal | undefined
  const authentication = authenticationService({
    listProviders: async (signal) => {
      loadSignal = signal
      return providers.promise
    },
  })
  const controller = createController(authentication)
  let publications = 0
  controller.subscribe(() => {
    publications += 1
  })

  controller.start()
  await Promise.resolve()
  const publicationsBeforeDispose = publications
  const reason = new Error("screen removed")
  controller.dispose(reason)
  providers.resolve([PROVIDER])
  await Promise.resolve()
  await Promise.resolve()

  expect(loadSignal?.aborted).toBe(true)
  expect(loadSignal?.reason).toBe(reason)
  expect(controller.getSnapshot()).toEqual({ type: "loading" })
  expect(publications).toBe(publicationsBeforeDispose)
})

test("a cancelled login cannot publish its late success", async () => {
  const loginResult = Promise.withResolvers<{
    providerId: string
    connected: boolean
  }>()
  let loginSignal: AbortSignal | undefined
  const authentication = authenticationService({
    listProviders: async () => [PROVIDER],
    login: async (providerId, _methodId, interaction) => {
      loginSignal = interaction.signal
      const status = await loginResult.promise
      return { ...status, providerId }
    },
  })
  const controller = createController(authentication)

  controller.start()
  await Promise.resolve()
  await Promise.resolve()
  controller.selectProvider("openai")
  controller.selectMethod("browser")
  expect(controller.getSnapshot().type).toBe("login")

  controller.cancel()
  expect(loginSignal?.aborted).toBe(true)
  expect(controller.getSnapshot().type).toBe("methods")
  loginResult.resolve({ providerId: "openai", connected: true })
  await Promise.resolve()
  await Promise.resolve()

  expect(controller.getSnapshot().type).toBe("methods")
})

test("disposed controller cannot start a hidden authentication operation", async () => {
  let loginCalls = 0
  const authentication = authenticationService({
    listProviders: async () => [PROVIDER],
    login: async (providerId) => {
      loginCalls += 1
      return { providerId, connected: true }
    },
  })
  const controller = createController(authentication)

  controller.start()
  await Promise.resolve()
  await Promise.resolve()
  controller.selectProvider("openai")
  expect(controller.getSnapshot().type).toBe("methods")

  controller.dispose()
  controller.selectMethod("browser")
  await Promise.resolve()

  expect(loginCalls).toBe(0)
  expect(controller.getSnapshot().type).toBe("methods")
})

function createController(
  authentication: IAuthenticationService,
  onClose: (outcome: TAuthenticationOutcome) => void = () => {},
): AuthenticationFlowController {
  return new AuthenticationFlowController({
    mode: "login",
    authentication,
    onClose,
    openUrl: () => {},
  })
}

function authenticationService(
  overrides: Partial<IAuthenticationService> = {},
): IAuthenticationService {
  return {
    listProviders: async () => [],
    login: async (providerId) => ({ providerId, connected: true }),
    logout: async () => false,
    dispose: async () => {},
    ...overrides,
  }
}
