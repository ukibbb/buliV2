import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import type { ReactNode } from "react"

import { Lifetime } from "@/lifetime"

type TRendererComposition = (
    lifetime: Lifetime,
) => ReactNode | Promise<ReactNode>

/** Runs one OpenTUI root under the application's coordinated lifetime. */
export async function runTuiRenderer(
    compose: TRendererComposition,
): Promise<void> {
    const lifetime = new Lifetime()
    const renderer = await createCliRenderer({
        externalOutputMode: "passthrough",
        targetFps: 60,
        gatherStats: false,
        exitOnCtrlC: true,
        useKittyKeyboard: {},
        autoFocus: false,
        openConsoleOnError: false,
        useMouse: true,
        clearOnShutdown: true,
        onDestroy: () => {
            void lifetime.close().catch(() => {})
        },
        consoleOptions: {
            sizePercent: 100,
            keyBindings: [{ name: "y", ctrl: true, action: "copy-selection" }],
        },
    })
    lifetime.addCleanup(() => {
        if (!renderer.isDestroyed) renderer.destroy()
    })

    const root = createRoot(renderer)
    lifetime.addCleanup(() => root.unmount())

    try {
        root.render(await compose(lifetime))
        await lifetime.waitForClose()
    } finally {
        await lifetime.close()
    }
}
