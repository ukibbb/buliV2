import { createBuliApplication, type IBuliApplicationStartup } from "@/application"
import { BuliApplicationLifecycle } from "@/tui/app/BuliApplicationLifecycle"
import type { Lifetime } from "@/lifetime"
import { runTuiRenderer } from "@/tui/host/run-tui-renderer"
import { openExternalUrl } from "@/tui/host/open-url"

/** Composes and runs the complete interactive Buli terminal application. */
export async function runMainTui(): Promise<void> {
    await runTuiRenderer((lifetime: Lifetime) => {

        const runtimeTask: Promise<IBuliApplicationStartup>
            = createBuliApplication({ signal: lifetime.signal })

        void runtimeTask.catch(() => { })
        lifetime.addCleanup(async () => {
            const startup = await runtimeTask.catch(() => undefined)
            // Startup jest jedynym ownerem złożonych zasobów. Entrypoint nie musi
            // znać ani powielać kolejności shutdownu runtime i authentication.
            await startup?.dispose(lifetime.signal.reason)
        })

        return (
            <BuliApplicationLifecycle
                runtimeTask={runtimeTask}
                openUrl={openExternalUrl}
            />
        )
    })
}
