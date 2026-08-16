import { realpath } from "node:fs/promises"

import type { IAgentModel, IAgentTool } from "@/agent/agent-types"
import { systemPrompt } from "@/agent/agents-prompts"
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
import {
    defaultSessionFilePath,
    JsonlSessionManager,
} from "@/session/jsonl-session-manager"
import type { ISessionManager } from "@/session/session-manager"
import { createWorkspaceTools } from "@/tools/workspace-tools"

const BULI_AGENT_ID = "buli"

export interface IBuliApplicationStartup {
    readonly runtime: IBuliApplication
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
    // ?? totalnie nie rozumiem dlaczego 2x wywolujemy throwIfAborted i po co
    // To dwa checkpointy po obu stronach operacji asynchronicznej. Pierwszy kończy
    // start od razu, jeśli sygnał był już anulowany, więc nie uruchamiamy `realpath`.
    // Podczas `await realpath(...)` sterowanie wraca do event loopa i właśnie wtedy
    // może nastąpić abort; samo `realpath` nie przyjmuje tutaj sygnału i go nie wykryje.
    // Drugie sprawdzenie wychwytuje taki abort i nie pozwala tworzyć managera, modelu,
    // runtime ani sesji. Bez abort oba wywołania nic nie robią, a po nim rzucają
    // `signal.reason`, przez co Promise zwracany przez tę funkcję zostaje odrzucony.
    options.signal.throwIfAborted()
    const workspaceRoot: string = await realpath(process.cwd())
    options.signal.throwIfAborted()

    const manager: ISessionManager = options.manager ?? new JsonlSessionManager({
        filePath: defaultSessionFilePath(workspaceRoot),
    })
    const model: IAgentModel = options.model ?? new OpenAiAgentModel()
    const models: readonly IBuliModelRegistration[] = [{
        id: DEFAULT_OPENAI_MODEL_ID,
        name: "GPT-5.6 Sol",
        model,
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
    const runtime = new BuliApplicationRuntime({
        workspaceRoot,
        manager,
        agents,
        defaultAgentId: BULI_AGENT_ID,
        models,
        selection,
    })

    options.signal.addEventListener("abort", () => {
        void runtime.dispose().catch(() => {})
    }, { once: true })
    return { runtime }
}
