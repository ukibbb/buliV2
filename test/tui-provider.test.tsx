import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"

import { createBuliApplication } from "@/app"
import { BuliRuntimeProvider } from "@/app/ui/context/application-context"
import { InMemorySessionManager } from "@/sessions/in-memory-session-manager"

test("renders provider children without creating root-level text", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "buli-provider-"))
  const startup = await createBuliApplication({
    signal: new AbortController().signal,
    workspaceRoot: workspace,
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
    await rm(workspace, { recursive: true, force: true })
    act(() => {
      setup.renderer.destroy()
    })
  }
})
