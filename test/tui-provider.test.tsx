import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"

import { BuliRuntimeProvider, createBuliApplication } from "@/application-state"

test("renders provider children without creating root-level text", async () => {
  const runtime = await createBuliApplication({
    signal: new AbortController().signal,
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
    act(() => {
      setup.renderer.destroy()
    })
  }
})
