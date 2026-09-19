import type { IAgentModel, IRuntimeAgentTool } from "@/agent"
import type { IBuliModelSelection } from "@/app/contracts"
import type {
    IBuliModelRuntimeConfig,
    TBuliModelRegistrationLoader,
} from "@/app/runtime"

export interface IModelComposition {
    readonly models: readonly IBuliModelRuntimeConfig[]
    readonly selection: IBuliModelSelection
    readonly additionalTools: readonly IRuntimeAgentTool[]
    readonly discovery?: {
        readonly loadModels: TBuliModelRegistrationLoader
        readonly preferredModelIds: readonly string[]
    }
}

export function createInjectedModelComposition(model: IAgentModel): IModelComposition {
    const modelId = "gpt-6-astra"
    return {
        models: [{
            id: modelId,
            name: "Injected model",
            model,
            reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
            defaultReasoningEffort: "medium",
        }],
        selection: { modelId, reasoningEffort: "medium" },
        additionalTools: [],
    }
}
