import {
    createBuliApplication,
    type IBuliApplicationOptions,
    type IBuliApplicationStartup,
} from "@/app/bootstrap/create-application"
import { ApplicationStartup } from "@/ui/startup/ApplicationStartup"
import {
    createHerdrAgentReporter,
    readHerdrPane,
} from "@/ui/integrations/herdr/herdr-agent-reporter"
import {
    type Lifetime,
    openExternalUrl,
    runTuiRenderer,
} from "@/ui/terminal"

/** Composes and runs the primary interactive Buli terminal application. */
export async function runMainTui(options: Pick<IBuliApplicationOptions, "appendSystemPromptFile"> = {}): Promise<void> {
    await runTuiRenderer((lifetime: Lifetime) => {

        const runtimeTask: Promise<IBuliApplicationStartup>
            = createBuliApplication({ ...options, signal: lifetime.signal })

        void runtimeTask.catch(() => { })
        lifetime.addCleanup(async () => {
            const startup = await runtimeTask.catch(() => undefined)
            await startup?.dispose(lifetime.signal.reason)
        })

        const herdrPane = readHerdrPane()

        return (
            <ApplicationStartup
                runtimeTask={runtimeTask}
                openUrl={openExternalUrl}
                {...(herdrPane ? { herdr: createHerdrAgentReporter(herdrPane) } : {})}
            />
        )
    })
}
