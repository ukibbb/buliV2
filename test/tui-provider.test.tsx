import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"

import { createBuliApplication } from "@/application"
import { BuliRuntimeProvider } from "@/application-state"
import { InMemorySessionStore } from "@/engine/session-store"

test("renders provider children without creating root-level text", async () => {
  const runtime = await createBuliApplication({
    signal: new AbortController().signal,
    store: new InMemorySessionStore(),
  })
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
    runtime.dispose()
    act(() => {
      setup.renderer.destroy()
    })
  }
})
