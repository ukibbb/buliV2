import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"

import { useBuliRuntime } from "@/application-state"
import { Layout } from "@/tui/components/Layout"
import { SessionScreen } from "@/tui/components/Session"

const DEFAULT_SESSION_ID = "default"

export function BuliTui() {
  const runtime = useBuliRuntime()
  const renderer = useRenderer()
  const { width, height } = useTerminalDimensions()

  // render welcome screen if not session
  // else choose session

  // useKeyboard
  useKeyboard((key) => {
    if (key.name === "escape") {
      key.preventDefault()
      runtime.abort(DEFAULT_SESSION_ID)
      return
    }

    if (key.ctrl && key.name === "d") renderer.console.toggle()
  })

  console.count("buli")
  return (
    <Layout width={width} height={height}>
      <SessionScreen sessionId={DEFAULT_SESSION_ID} />
    </Layout>
  )
}
