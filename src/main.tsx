import { createBuliApplication, type IBuliApplicationStartup } from "@/application"
import { BuliApplicationLifecycle } from "@/lifecycle"
import type { Lifetime } from "@/lifetime"
import { runTuiRenderer } from "@/tui/renderer-host"

export async function main(): Promise<void> {
    await runTuiRenderer((lifetime: Lifetime) => {

        const runtimeTask: Promise<IBuliApplicationStartup>
            = createBuliApplication({ signal: lifetime.signal })

        void runtimeTask.catch(() => { })
        lifetime.addCleanup(async () => {
            const startup = await runtimeTask.catch(() => undefined)
            await Promise.all([
                startup?.runtime.dispose(),
                startup?.authentication.dispose?.(),
            ])
        })

        return <BuliApplicationLifecycle runtimeTask={runtimeTask} />
    })
}
