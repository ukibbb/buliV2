import {
    createBuliApplication,
    type IBuliApplicationStartup,
} from "@/app/bootstrap/create-application"
import { BuliApplicationLifecycle } from "@/app/ui/shell/BuliApplicationLifecycle"
import {
    type Lifetime,
    openExternalUrl,
    runTuiRenderer,
} from "@/terminal"

/** Composes and runs the primary interactive Buli terminal application. */
export async function runMainTui(): Promise<void> {
    await runTuiRenderer((lifetime: Lifetime) => {

        const runtimeTask: Promise<IBuliApplicationStartup>
            = createBuliApplication({ signal: lifetime.signal })

        void runtimeTask.catch(() => { })
        lifetime.addCleanup(async () => {
            const startup = await runtimeTask.catch(() => undefined)
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
