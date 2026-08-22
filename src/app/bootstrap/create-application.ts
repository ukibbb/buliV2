import { realpath } from "node:fs/promises"

import { systemPrompt, type IAgentModel, type IAgentTool } from "@/agent"
import type { IAuthenticationService } from "@/authentication"
import { createAuthentication } from "@/app/bootstrap/create-authentication"
import type { IBuliModelSelection } from "@/app/contracts"
import type { IBuliApplication } from "@/app/contracts"
import {
    BuliApplicationRuntime,
    type IBuliAgentRuntimeConfig,
    type IBuliModelRuntimeConfig
} from "@/app/runtime"
import {
    DEFAULT_OPENAI_MODEL_ID,
    OPENAI_PROVIDER_ID,
    OpenAiAgentModel,
} from "@/providers/openai"
import {
    defaultSessionFilePath,
    type ISessionManager,
    JsonlSessionManager,
} from "@/sessions"
import { createWorkspaceTools } from "@/tools"

const BULI_AGENT_ID = "buli"

export interface IBuliApplicationStartup {
    readonly runtime: IBuliApplication
    readonly authentication: IAuthenticationService
    readonly dispose: (reason?: unknown) => Promise<void>
}

export interface IBuliApplicationOptions {
    readonly signal: AbortSignal
    readonly manager?: ISessionManager
    readonly model?: IAgentModel
    readonly tools?: readonly IAgentTool[]
}

/** Composes provider, tools, persistence, sessions, and the UI boundary. */
export async function createBuliApplication(
    options: IBuliApplicationOptions,
): Promise<IBuliApplicationStartup> {
    // AbortSignal działa tylko z API, które go obsługuje, np. fetch. realpath nie:
    // pierwszy checkpoint blokuje start po abort, drugi zatrzymuje dalszy startup,
    // ale rozpoczętego realpath nie da się tu przerwać. Po aborcie rzucany jest reason.
    options.signal.throwIfAborted()
    const workspaceRoot: string = await realpath(process.cwd())
    options.signal.throwIfAborted()

    const auth = createAuthentication()
    const authentication = auth.service
    // Od tego miejsca startup posiada auth. Jeśli późniejszy etap rzuci, rollback
    // nie zostawi częściowo utworzonej usługi bez właściciela.
    let runtime: BuliApplicationRuntime | undefined
    let manager: ISessionManager | undefined
    try {
        manager = options.manager ?? new JsonlSessionManager({
            filePath: defaultSessionFilePath(workspaceRoot),
        })
        const model: IAgentModel = options.model ?? new OpenAiAgentModel({
            auth: auth.openAi,
        })
        const models: readonly IBuliModelRuntimeConfig[] = [{
            id: DEFAULT_OPENAI_MODEL_ID,
            name: "GPT-5.6 Sol",
            model,
            modelProfile: {
                providerId: OPENAI_PROVIDER_ID,
                modelId: DEFAULT_OPENAI_MODEL_ID,
            },
            reasoningEfforts: [
                "none",
                "low",
                "medium",
                "high",
                "xhigh",
                "max",
            ],
        }]
        const selection: IBuliModelSelection = {
            modelId: DEFAULT_OPENAI_MODEL_ID,
            reasoningEffort: "medium",
        }
        const tools: readonly IAgentTool[] = options.tools
            ?? createWorkspaceTools(workspaceRoot)

        const agents: readonly IBuliAgentRuntimeConfig[] = [{
            id: BULI_AGENT_ID,
            name: "Buli",
            systemPrompt: systemPrompt(workspaceRoot, tools),
            tools,
        }]

        //
        const applicationRuntime = new BuliApplicationRuntime({
            workspaceRoot,
            manager,
            agents,
            defaultAgentId: BULI_AGENT_ID,
            models,
            selection,
        })
        runtime = applicationRuntime

        let disposePromise: Promise<void> | undefined
        let removeAbortListener: (() => void) | undefined

        const dispose = (
            reason: unknown = abortError("Buli application is shutting down"),
        ): Promise<void> => {
            if (disposePromise) return disposePromise

            const completion = Promise.withResolvers<void>()
            disposePromise = completion.promise

            removeAbortListener?.()
            removeAbortListener = undefined

            void disposeApplicationResources(
                applicationRuntime,
                authentication,
                reason,
            ).then(
                completion.resolve,
                completion.reject,
            )
            return disposePromise
        }

        const disposeOnAbort = (): void => {
            void dispose(options.signal.reason).catch(() => { })
        }
        options.signal.addEventListener("abort", disposeOnAbort, { once: true })
        removeAbortListener = () => {
            options.signal.removeEventListener("abort", disposeOnAbort)
        }
        if (options.signal.aborted) disposeOnAbort()

        return { runtime: applicationRuntime, authentication, dispose }
    } catch (startupError) {
        const rollbackResults = await Promise.allSettled([

            runtime?.dispose() ?? manager?.dispose?.(),
            authentication.dispose(startupError),
        ])
        const rollbackErrors = rollbackResults.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : []
        )
        if (rollbackErrors.length > 0) {
            throw new AggregateError(
                [startupError, ...rollbackErrors],
                "Buli startup rollback failed",
            )
        }
        throw startupError
    }
}

async function disposeApplicationResources(
    runtime: IBuliApplication,
    authentication: IAuthenticationService,
    reason: unknown,
): Promise<void> {
    const results = await Promise.allSettled([
        runtime.dispose(),
        authentication.dispose(reason),
    ])
    const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
    )
    if (errors.length > 0) {
        throw new AggregateError(errors, "Buli application shutdown failed")
    }
}

function abortError(message: string): Error {
    const error = new Error(message)
    error.name = "AbortError"
    return error
}
