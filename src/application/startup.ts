import { realpath } from "node:fs/promises"

import type { IAgentModel, IAgentTool } from "@/agent/agent-types"
import { systemPrompt } from "@/agent/agents-prompts"
import type { IAuthenticationService } from "@/auth/contracts"
import { createAuthentication } from "@/auth/create-authentication"
import type { IBuliModelSelection } from "@/application/contracts"
import type { IBuliApplication } from "@/application/contracts"
import {
    BuliApplicationRuntime,
    type IBuliAgentRegistration,
    type IBuliModelRegistration,
} from "@/application/runtime"
import {
    DEFAULT_OPENAI_MODEL_ID,
    OpenAiAgentModel,
} from "@/providers/openai/openai-agent-model"
import { OPENAI_PROVIDER_ID } from "@/providers/openai/openai-auth"
import {
    defaultSessionFilePath,
    JsonlSessionManager,
} from "@/session/jsonl-session-manager"
import type { ISessionManager } from "@/session/session-manager"
import { createWorkspaceTools } from "@/tools/workspace-tools"

const BULI_AGENT_ID = "buli"

export interface IBuliApplicationStartup {
    readonly runtime: IBuliApplication
    readonly authentication: IAuthenticationService
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

    const auth = createAuthentication({ signal: options.signal })
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
        const models: readonly IBuliModelRegistration[] = [{
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

        const agents: readonly IBuliAgentRegistration[] = [{
            id: BULI_AGENT_ID,
            name: "Buli",
            systemPrompt: systemPrompt(workspaceRoot),
            tools,
        }]

        //
        runtime = new BuliApplicationRuntime({
            workspaceRoot,
            manager,
            agents,
            defaultAgentId: BULI_AGENT_ID,
            models,
            selection,
        })

        // Listener abort działa synchronicznie, ale dispose jest async: tutaj je zaczynamy,
        // a cleanup Lifetime czeka później na ten sam, zapamiętany Promise dispose.
        options.signal.addEventListener("abort", () => {
            void runtime?.dispose().catch(() => { })
        }, { once: true })

        return { runtime, authentication }
    } catch (startupError) {
        // allSettled zawsze próbuje obu cleanupów. Gdy rollback też zawiedzie,
        // AggregateError zachowuje błąd startupu jako pierwszy i nie ukrywa reszty.
        const rollbackResults = await Promise.allSettled([
            // Runtime posiada manager po udanej konstrukcji; wcześniej startup musi
            // zwolnić go sam, szczególnie gdy trzyma wyłączny lock pliku sesji.
            runtime?.dispose() ?? manager?.dispose?.(),
            authentication.dispose?.(startupError),
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
