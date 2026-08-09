import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"

import { createBuliApplication } from "@/application"
import { BuliApplicationLifecycle } from "@/lifecycle"
import { Lifetime } from "@/lifetime"

export async function main(): Promise<void> {
  const lifetime = new Lifetime()
  const renderer = await createCliRenderer({
    externalOutputMode: "passthrough",
    targetFps: 60,
    gatherStats: false,
    exitOnCtrlC: true, // false in opencode -> check why?
    useKittyKeyboard: {},
    autoFocus: false,
    openConsoleOnError: false,
    useMouse: true,
    clearOnShutdown: true,
    consoleOptions: {
      sizePercent: 100,
      keyBindings: [{ name: "y", ctrl: true, action: "copy-selection" }],
    },
  })
  const root = createRoot(renderer)
  const runtimeTask = createBuliApplication({ signal: lifetime.signal })

  root.render(<BuliApplicationLifecycle runtimeTask={runtimeTask} />)
}
