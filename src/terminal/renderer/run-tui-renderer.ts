import {
    createCliRenderer,
    createClipboard,
    createHostClipboard,
    createRendererClipboardAdapter,
} from "@opentui/core"
import { createRoot } from "@opentui/react"
import { createElement, type ReactNode } from "react"

import { TerminalSelectionClipboardRoot } from "@/terminal/clipboard/ClipboardOverlay"
import { registerTerminalParsers } from "@/terminal/parsers"
import { Lifetime } from "@/terminal/renderer/lifetime"
import { theme } from "@/terminal/theme"

type TRendererComposition = (
    lifetime: Lifetime,
) => ReactNode | Promise<ReactNode>

/** Runs one OpenTUI root under the application's coordinated lifetime. */
export async function runTuiRenderer(
    compose: TRendererComposition,
): Promise<void> {
    registerTerminalParsers()
    const lifetime = new Lifetime()
    // `finally` obejmuje cały setup: błąd po zdobyciu zasobu nadal uruchomi jego
    // cleanup, więc terminal nie zostanie pozostawiony w trybie OpenTUI.
    let runFailed = false
    let runError: unknown
    try {
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
            backgroundColor: theme.background,
            onDestroy: () => {
                void lifetime.close().catch(() => {})
            },
            consoleOptions: {
                sizePercent: 100,
                colorInfo: theme.blue,
                colorWarn: theme.amber,
                colorError: theme.red,
                colorDebug: theme.violet,
                colorDefault: theme.text,
                backgroundColor: theme.background,
                title: "Buli console",
                titleBarColor: theme.surfaceRaised,
                titleBarTextColor: theme.green,
                cursorColor: theme.green,
                selectionColor: theme.selectionBg,
                copyButtonColor: theme.cyan,
                keyBindings: [{ name: "y", ctrl: true, action: "copy-selection" }],
            },
        })
        // Rejestrujemy cleanup natychmiast po utworzeniu zasobu. Późniejszy błąd
        // nie musi wiedzieć, które wcześniejsze etapy setupu już się udały.
        lifetime.addCleanup(() => {
            if (!renderer.isDestroyed) renderer.destroy()
        })

        const clipboard = createClipboard({
            host: createHostClipboard(),
            terminal: createRendererClipboardAdapter(renderer),
        })
        lifetime.addCleanup(() => clipboard.dispose())

        const root = createRoot(renderer)
        lifetime.addCleanup(() => root.unmount())

        root.render(createElement(
            TerminalSelectionClipboardRoot,
            {
                clipboard,
                onClipboardWriteError: (error: unknown) => {
                    console.error("Failed to copy terminal selection", error)
                },
                children: await compose(lifetime),
            },
        ))
        await lifetime.waitForClose()
    } catch (error) {
        // Zachowujemy błąd setupu/renderowania i przekazujemy go jako reason abortu.
        runFailed = true
        runError = error
    } finally {
        // close() jest idempotentne, więc to także bezpieczny fallback po onDestroy.
        try {
            if (runFailed) await lifetime.close(runError)
            else await lifetime.close()
        } catch (closeError) {
            // waitForClose może zwrócić ten sam błąd close; nie duplikujemy go.
            if (runFailed && closeError !== runError) {
                throw new AggregateError(
                    [runError, closeError],
                    "Buli renderer failed and shutdown also failed",
                )
            }
            throw closeError
        }
    }
    if (runFailed) throw runError
}
