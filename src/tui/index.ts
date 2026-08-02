import { ConsolePosition, createCliRenderer, type CliRendererConfig } from "@opentui/core";
import { createElement, createRoot } from "@opentui/react";

import { BuliRuntimeProvider, createBuliApplication } from "@/application-state";
import { BuliTui } from "@/tui/Buli";

const BuliRendererConfig: CliRendererConfig = {
  screenMode: "alternate-screen",
  stdin: process.stdin,
  stdout: process.stdout,
  externalOutputMode: "passthrough",
  targetFps: 60,
  consoleMode: "console-overlay",
  consoleOptions: {
    position: ConsolePosition.BOTTOM,
    sizePercent: 40,
    title: "Buli Logs",
    backgroundColor: "#121212",
    titleBarColor: "#262626",
    titleBarTextColor: "#FAFAFA",
    colorDefault: "#E5E5E5",
    colorDebug: "#A3A3A3",
    colorInfo: "#5EEAD4",
    colorWarn: "#FACC15",
    colorError: "#FB7185",
    cursorColor: "#86EFAC",
    selectionColor: "#404040",
    copyButtonColor: "#5EEAD4",
    startInDebugMode: true,
  },
  exitOnCtrlC: true,
  clearOnShutdown: true,
  useMouse: true,
  autoFocus: true,
  enableMouseMovement: true,
  useKittyKeyboard: {},
  backgroundColor: "transparent",
  openConsoleOnError: true,
  onDestroy: () => { },
}
export async function runBuliTui(): Promise<void> {
  const renderer = await createCliRenderer(BuliRendererConfig);
  const runtime = createBuliApplication()

  createRoot(renderer).render(
    createElement(
      BuliRuntimeProvider,
      {
        runtime,
        children: createElement(BuliTui),
      },
    ),
  )
}
