import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"

import { createBuliApplication } from "@/application"
import { BuliRuntimeProvider } from "@/tui/app/application-context"
import { InMemorySessionManager } from "@/session/session-manager"

test("renders provider children without creating root-level text", async () => {
  const startup = await createBuliApplication({
    signal: new AbortController().signal,
    manager: new InMemorySessionManager(),
    model: { async *stream() {} },
    tools: [],
  })
  const { runtime } = startup
  const setup = await testRender(
    <BuliRuntimeProvider runtime={runtime}>
      <box>
        <text>ready</text>
      </box>
    </BuliRuntimeProvider>,
    { width: 20, height: 4 },
  )

  try {
    await act(async () => {
      await setup.renderOnce()
    })

    expect(setup.captureCharFrame()).toContain("ready")
  } finally {
    const disposal = startup.dispose()
    expect(startup.dispose()).toBe(disposal)
    await disposal
    act(() => {
      setup.renderer.destroy()
    })
  }
})
