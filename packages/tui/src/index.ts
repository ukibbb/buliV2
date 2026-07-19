import { ConsolePosition, createCliRenderer, type CliRendererConfig } from "@opentui/core";
import { createElement, createRoot } from "@opentui/react";

import { Buli } from "./Buli";

const BuliRendererConfig: CliRendererConfig = {
  screenMode: "alternate-screen",
  // stdin: from where keyboard inputs come from
  stdin: process.stdin,
  // stdout: this is where opentui writes terminal output
  stdout: process.stdout,


  // width: fallback terminal height
  // height: fallback terminal width
  // remote: handles remote terminals

  //
  //This controls what happens when your app writes to stdout.write(...).
  //Important: this is not the same as OpenTUI drawing its UI.
  // passthrough: Output goes straight to terminal.
  externalOutputMode: "passthrough",
  //Use when you do not need split-footer captured output.
  // "capture-stdout" OpenTUI catches stdout.write, queues it, and prints it above the split footer.
  // Only valid with:
  // screenMode: "split-footer"
  //
  //
  targetFps: 60,
  // Keep logs available for Ctrl+L; SHOW_CONSOLE=1 opens the panel on startup.
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
  // on ctrl+c opentui calls renderer.destroy()
  exitOnCtrlC: true,

  // exitSignals: handles os messages, when signal happen clear up renderer
  //
  clearOnShutdown: true,
  useMouse: true,
  //
  // If user clicks a focusable thing, OpenTUI focuses it automatically.
  // Example: clicking an input focuses the input.
  autoFocus: true,

  // controls mouse move events
  // If true, OpenTUI tracks movement, hover, drag-like behavior.
  // If false, you can still care about clicks/scrolls but avoid
  // constant movement events.
  // Use false if mouse movement creates too much noise.
  enableMouseMovement: true,

  // enables kitty keyboard protocol supports
  // better keyboard events from modern terminal
  // It helps distinguish tricky keys, modifiers, Alt/Escape ambiguity
  useKittyKeyboard: {},


  backgroundColor: "transparent",
  openConsoleOnError: true,

  // runs after render cleanup finishes
  onDestroy: () => { },

  // bufferedOutput: Instead of writing to a real terminal, renderer can write to an in-memory/native buffered output destination.
  // Use for tests, snapshots, or non-terminal inspection.
  //
  // forwardEnvKeys: Advanced terminal detection option.
  // OpenTUI forwards selected environment variables to native terminal detection.
  // Example:
  // forwardEnvKeys: ["TERM", "COLORTERM"]
  // Use only when custom/remote terminal detection needs env data.
  //
  // debounceDelay: Default: 100ms. When terminal resizes, wait a tiny moment before reacting.
  // Why? Resize events can arrive in bursts.
  // debounceDelay: 50
  // Lower = reacts faster.
  // Higher = less noisy.
  //
  // memorySnapshotInterval
  // Default: 0
  // Controls automatic memory snapshots.
  // memorySnapshotInterval: 1000
  // Means: emit memory info every 1000ms.
  // 0 means disabled.
  // Useful for debug overlays/performance debugging.
  //
  // useThread
  // Advanced performance option.
  // Tells renderer to use a separate render thread when supported.
  // useThread: true
  // Simple meaning:
  // Do rendering work away from the main JS flow if possible.
  // Most apps should leave it alone unless docs/examples tell you otherwise.
  //
  // gatherStats
  // Default: false
  // Collect frame timing stats.
  // gatherStats: true
  // Useful for debug overlay, FPS, render timing.
  // Costs a little overhead.
  //
  // maxStatSamples
  // Default: 300
  // How many frame timing samples to keep.
  // maxStatSamples: 600
  // More samples = longer history.
  // Fewer samples = less memory.
  //
  // postProcessFns
  // Advanced rendering hook.
  // Runs functions after each render pass.
  // postProcessFns: [
  //   (buffer, deltaTime) => {
  //     // modify or inspect final buffer
  //   },
  // ]
  //
  // Simple meaning:
  // “After OpenTUI draws, let me touch the final frame before it goes out.”
  // Use for effects, filters, custom debugging.
  //
  // prependInputHandlers
  // Input handlers that run before built-in handlers.
  // prependInputHandlers: [
  //   (sequence) => {
  //     if (sequence === "\x1b[A") return true
  //     return false
  //   },
  // ]
  // Return true means:
  // “I handled it. Stop.”
  // Return false means:
  // “Let other handlers try.”
  // Docs also mention normal addInputHandler() appends handlers after built-ins, while prependInputHandler() runs before built-ins. (opentui.com (https://opentui.com/docs/core-concepts/renderer/))
  //
  // stdinParserMaxBufferBytes
  // Default: 64 MB
  // Maximum pending input buffer size.
  // stdinParserMaxBufferBytes: 1024 * 1024
  // Use only if you need to limit huge paste/input data.
  //
  // clock
  // Advanced testing option.
  // Lets you provide a fake/custom clock.
  // Useful in tests where you want deterministic timers.
  // clock: fakeClock
  // Most real apps do not need this.
}


export async function runBuliTui(): Promise<void> {

  const renderer = await createCliRenderer(BuliRendererConfig);

  createRoot(renderer).render(createElement(Buli));
}
