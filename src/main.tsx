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

    const runtimeTask = createBuliApplication({ signal: lifetime.signal })
    void runtimeTask.catch(() => {})
    lifetime.addCleanup(async () => {
        const startup = await runtimeTask.catch(() => undefined)
        await startup?.runtime.dispose()
    })

    try {
        root.render(<BuliApplicationLifecycle runtimeTask={runtimeTask} />)
        await lifetime.waitForClose()
    } finally {
        await lifetime.close()
    }
}
