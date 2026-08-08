import type { IBuliApplicationRuntime } from "@/runtime";
import { createCliRenderer, type CliRenderer } from "@opentui/core";
import { type Root, createRoot } from "@opentui/react";

import { BuliApplicationLifcycle } from "@/lifecycle";
import { createBuliApplication } from "@/application-state";
import { Lifetime } from "@/lifetime";


export async function main(): Promise<void> {
  let renderer: CliRenderer | undefined

  let root: Root | undefined
  let runtimeTask: Promise<IBuliApplicationRuntime> | undefined
  const lifetime = new Lifetime()


  renderer = await createCliRenderer({
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

  root = createRoot(renderer)

  runtimeTask = createBuliApplication({ signal: lifetime.signal })

  root.render(<BuliApplicationLifcycle runtimeTask={runtimeTask} onStartupError={(error) => { }} onExit={() => { }} />)










}
