import { expect, test } from "bun:test"
import {
  parseKeypress,
  type Renderable,
  TextRenderable,
} from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { act, type ReactNode } from "react"

import type {
    IAuthProviderInfo,
    IAuthenticationService,
} from "@/authentication/contracts"
import { AuthenticationFlow } from "@/authentication/ui/AuthenticationFlow"
import type { TAuthenticationOutcome } from "@/authentication/ui/types"

const LOGIN_PROVIDER: IAuthProviderInfo = {
  providerId: "cloud",
  name: "Cloud Account",
  connected: false,
  methods: [{
    id: "browser",
    name: "Browser login",
    description: "Authorize in a browser",
  }],
}

function linkTargets(root: Renderable): string[] {
  return [
    ...(root instanceof TextRenderable
      ? root.textNode.gatherWithInheritedStyle().flatMap((chunk) =>
        chunk.link ? [chunk.link.url] : []
      )
      : []),
    ...root.getChildren().flatMap(linkTargets),
  ]
}

test("selects provider and method before showing progress and manual input", async () => {
  const continueLogin = Promise.withResolvers<void>()
  const updateAuthorization = Promise.withResolvers<void>()
  const openedUrls: string[] = []
  const manualInputs: string[] = []
  const loginCalls: Array<{ providerId: string; methodId: string }> = []
  let closeCount = 0
  const authentication: IAuthenticationService = {
    listProviders: async () => [LOGIN_PROVIDER],
    login: async (providerId, methodId, interaction) => {
      loginCalls.push({ providerId, methodId })
      await interaction.notify({
        type: "progress",
        message: "Preparing secure login",
      })
      await continueLogin.promise
      await interaction.notify({
        type: "authorization",
        url: "https://auth.example.test/preflight",
        instructions: "Begin authorization in your browser.",
      })
      await updateAuthorization.promise
      await interaction.notify({
        type: "authorization",
        url: "https://auth.example.test/authorize",
        instructions: "Complete authorization in your browser.",
      })
      manualInputs.push(await interaction.prompt({
        type: "manual-callback",
        message: "Paste the callback URL:",
        placeholder: "http://localhost/callback",
        signal: interaction.signal,
      }))
      return {
        providerId,
        connected: true,
        accountId: "account-123",
      }
    },
    logout: async () => false,
    dispose: async () => {},
  }
  const setup = await renderAuthenticationFlow(
    <AuthenticationFlow
      mode="login"
      authentication={authentication}
      onClose={() => {
        closeCount += 1
      }}
      openUrl={async (url) => {
        openedUrls.push(url)
        throw new Error("No browser in tests")
      }}
    />,
  )

  try {
    await act(async () => {
      await setup.renderOnce()
      await Promise.resolve()
      await setup.renderOnce()
    })
    let frame = setup.captureCharFrame()
    expect(frame).toContain("Select a provider")
    expect(frame).toContain("Cloud Account")
    expect(frame).not.toContain("Select a login method")
    expect(loginCalls).toEqual([])

    await pressKey(setup, "\r")
    frame = await setup.waitForFrame((value) =>
      value.includes("Select a login method")
    )
    expect(frame).toContain("Select a login method")
    expect(frame).toContain("Browser login")
    expect(loginCalls).toEqual([])

    await pressKey(setup, "\r")
    frame = await setup.waitForFrame((value) =>
      value.includes("Preparing secure login")
    )
    expect(frame).not.toContain("https://auth.example.test/authorize")

    await act(async () => {
      continueLogin.resolve()
      await continueLogin.promise
      await Promise.resolve()
      await setup.renderOnce()
    })
    frame = await setup.waitForFrame((value) =>
      value.includes("https://auth.example.test/preflight")
      && value.includes("Could not open the browser automatically")
    )
    expect(linkTargets(setup.renderer.root)).toContain(
      "https://auth.example.test/preflight",
    )

    await act(async () => {
      updateAuthorization.resolve()
      await updateAuthorization.promise
      await Promise.resolve()
      await setup.renderOnce()
    })
    frame = await setup.waitForFrame((value) =>
      value.includes("Paste the callback URL:")
    )
    expect(frame).toContain("Complete authorization in your browser.")
    expect(frame).toContain("https://auth.example.test/authorize")
    expect(frame).toContain("Could not open the browser automatically")
    expect(linkTargets(setup.renderer.root)).toContain(
      "https://auth.example.test/authorize",
    )
    expect(linkTargets(setup.renderer.root)).not.toContain(
      "https://auth.example.test/preflight",
    )
    expect(openedUrls).toEqual([
      "https://auth.example.test/preflight",
      "https://auth.example.test/authorize",
    ])

    await act(async () => {
      await setup.mockInput.typeText("callback-code#state")
      setup.mockInput.pressEnter()
      await Promise.resolve()
      await setup.renderOnce()
    })
    frame = await setup.waitForFrame((value) =>
      value.includes("Sign-in complete")
    )
    expect(frame).toContain("Provider: Cloud Account")
    expect(frame).toContain("Account: account-123")
    expect(manualInputs).toEqual(["callback-code#state"])
    expect(loginCalls).toEqual([{
      providerId: "cloud",
      methodId: "browser",
    }])

    await pressKey(setup, "\r")
    expect(closeCount).toBe(1)
  } finally {
    act(() => {
      setup.renderer.destroy()
    })
  }
})

test("Escape aborts an active login and returns to method selection", async () => {
  let loginSignal: AbortSignal | undefined
  let closeCount = 0
  const authentication: IAuthenticationService = {
    listProviders: async () => [LOGIN_PROVIDER],
    login: async (providerId, _methodId, interaction) => {
      loginSignal = interaction.signal
      await interaction.notify({
        type: "device",
        url: "https://auth.example.test/device",
        userCode: "ABCD-EFGH",
        instructions: "Enter this code on another device.",
      })
      await interaction.prompt({
        type: "manual-callback",
        message: "Paste a callback:",
        placeholder: "callback",
        signal: interaction.signal,
      })
      return { providerId, connected: true }
    },
    logout: async () => false,
    dispose: async () => {},
  }
  const setup = await renderAuthenticationFlow(
    <AuthenticationFlow
      mode="login"
      authentication={authentication}
      onClose={() => {
        closeCount += 1
      }}
      openUrl={() => undefined}
    />,
  )

  try {
    await act(async () => {
      await setup.renderOnce()
      await Promise.resolve()
      await setup.renderOnce()
    })
    await pressKey(setup, "\r")
    await pressKey(setup, "\r")

    const progressFrame = await setup.waitForFrame((value) =>
      value.includes("Paste a callback:")
    )
    expect(progressFrame).toContain("https://auth.example.test/device")
    expect(progressFrame).toContain("Device code: ABCD-EFGH")

    await pressKey(setup, "\u001b")

    await setup.waitForFrame((value) =>
      value.includes("Select a login method")
    )
    expect(loginSignal?.aborted).toBe(true)
    expect(setup.captureCharFrame()).toContain("Select a login method")
    expect(closeCount).toBe(0)
  } finally {
    act(() => {
      setup.renderer.destroy()
    })
  }
})

test("logout prioritizes connected providers and asks for confirmation", async () => {
  const providers: readonly IAuthProviderInfo[] = [
    {
      providerId: "connected",
      name: "Connected Account",
      connected: true,
      accountId: "user@example.test",
      methods: [],
    },
    {
      providerId: "repair",
      name: "Needs Repair",
      connected: false,
      statusError: "Authentication status is unavailable",
      methods: [],
    },
    {
      providerId: "offline",
      name: "Offline Account",
      connected: false,
      methods: [],
    },
  ]
  const logoutCalls: string[] = []
  const authentication: IAuthenticationService = {
    listProviders: async () => providers,
    login: async () => {
      throw new Error("Unexpected login")
    },
    logout: async (providerId) => {
      logoutCalls.push(providerId)
      return true
    },
    dispose: async () => {},
  }
  const setup = await renderAuthenticationFlow(
    <AuthenticationFlow
      mode="logout"
      authentication={authentication}
      onClose={() => undefined}
      openUrl={() => undefined}
    />,
  )

  try {
    await act(async () => {
      await setup.renderOnce()
      await Promise.resolve()
      await setup.renderOnce()
    })
    let frame = setup.captureCharFrame()
    expect(frame).toContain("Connected Account")
    expect(frame).toContain("Needs Repair")
    expect(frame).toContain("Authentication needs repair")
    expect(frame).toContain("Offline Account")

    await pressKey(setup, "\r")
    frame = await setup.waitForFrame((value) =>
      value.includes("Disconnect Connected Account?")
    )
    expect(frame).toContain("Disconnect Connected Account?")
    expect(frame).toContain("Account: user@example.test")
    expect(logoutCalls).toEqual([])

    await pressKey(setup, "\r")
    frame = await setup.waitForFrame((value) =>
      value.includes("Sign-out complete")
    )
    expect(frame).toContain("Provider: Connected Account")
    expect(logoutCalls).toEqual(["connected"])
  } finally {
    act(() => {
      setup.renderer.destroy()
    })
  }
})

test("an empty provider picker closes cleanly on Enter", async () => {
  const outcomes: TAuthenticationOutcome[] = []
  const authentication: IAuthenticationService = {
    listProviders: async () => [],
    login: async () => {
      throw new Error("Unexpected login")
    },
    logout: async () => false,
    dispose: async () => {},
  }
  const setup = await renderAuthenticationFlow(
    <AuthenticationFlow
      mode="logout"
      authentication={authentication}
      onClose={(outcome) => outcomes.push(outcome)}
      openUrl={() => undefined}
    />,
  )

  try {
    await act(async () => {
      await setup.renderOnce()
      await Promise.resolve()
      await setup.renderOnce()
    })
    expect(setup.captureCharFrame()).toContain("No authentication providers")
    expect(setup.captureCharFrame()).toContain("enter or esc close")

    await pressKey(setup, "\r")
    expect(outcomes).toEqual(["success"])
  } finally {
    act(() => {
      setup.renderer.destroy()
    })
  }
})

test("scrolls authentication choices inside a short card", async () => {
  const authentication: IAuthenticationService = {
    listProviders: async () => [LOGIN_PROVIDER],
    login: async () => {
      throw new Error("Unexpected login")
    },
    logout: async () => false,
    dispose: async () => {},
  }
  const setup = await renderAuthenticationFlow(
    <AuthenticationFlow
      mode="login"
      authentication={authentication}
      onClose={() => undefined}
      openUrl={() => undefined}
    />,
    { width: 35, height: 14 },
  )

  try {
    await act(async () => {
      await setup.renderOnce()
      await Promise.resolve()
      await setup.renderOnce()
    })
    expect(setup.captureCharFrame()).toContain("Select a provider")

    await pressKey(setup, "\u001b[6~")
    expect(setup.captureCharFrame()).toContain("enter select  esc close")
  } finally {
    act(() => {
      setup.renderer.destroy()
    })
  }
})

async function pressKey(
  setup: Awaited<ReturnType<typeof testRender>>,
  input: string,
): Promise<void> {
  await act(async () => {
    if (input === "\r") setup.mockInput.pressEnter()
    else {
      const key = parseKeypress(input)
      if (!key) throw new Error(`Could not parse key: ${JSON.stringify(input)}`)
      setup.renderer.keyInput.processParsedKey(key)
    }
    await Promise.resolve()
    await setup.flush()
    await setup.renderOnce()
  })
}

async function renderAuthenticationFlow(
  node: ReactNode,
  options: { readonly width: number; readonly height: number } = {
    width: 80,
    height: 24,
  },
): Promise<Awaited<ReturnType<typeof testRender>>> {
  let setup: Awaited<ReturnType<typeof testRender>> | undefined
  await act(async () => {
    setup = await testRender(node, options)
    await Promise.resolve()
  })
  if (!setup) throw new Error("Authentication flow did not render")
  return setup
}
