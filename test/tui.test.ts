import { expect, test } from "bun:test"
import { parseKeypress } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { act, createElement } from "react"

import {
  BuliApplicationRuntime,
  createBuliApplication,
  type IBuliApplication,
} from "@/application"
import { BuliRuntimeProvider } from "@/application-state"
import type { IAgentModel } from "@/agent/agent-types"
import type { ISessionSnapshot } from "@/domain"
import { InMemorySessionManager } from "@/session/session-manager"
import { BuliTui } from "@/tui/Buli"

const WORKSPACE_ROOT = "/workspace"

test("provides the runtime above Buli", async () => {
  const runtime = await createBuliApplication({
    signal: new AbortController().signal,
    manager: new InMemorySessionManager(),
    model: { async *stream() {} },
    tools: [],
  })
  const setup = await testRender(
    createElement(BuliRuntimeProvider, {
      runtime,
      children: createElement(BuliTui),
    }),
    { width: 80, height: 24 },
  )

  try {
    await act(async () => {
      await setup.renderOnce()
    })
    const frame = setup.captureCharFrame()

    expect(frame.trim()).not.toBe("")
    expect(frame).not.toContain("Buli runtime not available")
  } finally {
    runtime.dispose()
    act(() => {
      setup.renderer.destroy()
    })
  }
})

test("Escape aborts the default session while chat input is focused", async () => {
  const aborted: string[] = []
  const snapshot: ISessionSnapshot = {
    messages: [],
    isRunning: false,
    pendingToolCallIDs: [],
  }
  const session = {
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
  }
  const runtime: IBuliApplication = {
    workspaceRoot: WORKSPACE_ROOT,
    submitPrompt: async () => undefined,
    abort: (sessionId) => aborted.push(sessionId),
    getAgentSession: () => session,
  }
  const setup = await testRender(
    createElement(BuliRuntimeProvider, {
      runtime,
      children: createElement(BuliTui),
    }),
    { width: 80, height: 24 },
  )

  try {
    await act(async () => {
      await setup.renderOnce()
    })

    const escape = parseKeypress("\u001b")
    if (!escape) throw new Error("Expected Escape to parse as a keypress")

    await act(async () => {
      setup.renderer.keyInput.processParsedKey(escape)
      await setup.renderOnce()
    })

    expect(aborted).toEqual(["default"])
  } finally {
    act(() => {
      setup.renderer.destroy()
    })
  }
})

test("renders a submitted prompt and streamed response", async () => {
  const model: IAgentModel = {
    async *stream() {
      yield { type: "text-start", id: "answer" }
      yield { type: "text-delta", id: "answer", delta: "Rendered response" }
      yield { type: "text-end", id: "answer" }
      yield { type: "finish", reason: "stop" }
    },
  }
  const runtime = new BuliApplicationRuntime({
    workspaceRoot: WORKSPACE_ROOT,
    manager: new InMemorySessionManager(),
    model,
    tools: [],
    systemPrompt: "System",
  })
  const setup = await testRender(
    createElement(BuliRuntimeProvider, {
      runtime,
      children: createElement(BuliTui),
    }),
    { width: 80, height: 24 },
  )

  try {
    await act(async () => {
      await setup.renderOnce()
      await runtime.submitPrompt({ sessionId: "default", text: "Rendered prompt" })
      await setup.renderOnce()
    })
    await setup.waitForVisualIdle()
    await Bun.sleep(50)

    const frame = setup.captureCharFrame()
    expect(frame).toContain("Rendered prompt")
    expect(frame).toContain("Rendered response")
  } finally {
    runtime.dispose()
    act(() => {
      setup.renderer.destroy()
    })
  }
})
