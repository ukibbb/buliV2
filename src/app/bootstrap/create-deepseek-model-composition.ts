import type { IModelComposition } from "./model-composition"
import type { IBuliModelRuntimeConfig } from "@/app/runtime"
import { DeepSeekAgentModel } from "@/providers/deepseek"
import { createDeepSeekModelCatalog, type IDeepSeekModelCatalog } from "@/providers/deepseek"

export function createDeepSeekModelComposition(options: {
    readonly auth: { readonly authenticatedFetch: typeof fetch }
    readonly catalog?: IDeepSeekModelCatalog
}): IModelComposition {
    const catalog = options.catalog ?? createDeepSeekModelCatalog({ auth: options.auth })
    return {
        models: [],
        selection: { modelId: "deepseek/deepseek-flash", reasoningEffort: "high" },
        additionalTools: [],
        discovery: {
            preferredModelIds: [],
            loadModels: async signal => (await catalog.load(signal)).map((entry): IBuliModelRuntimeConfig => ({
                id: `deepseek/${entry.modelId}`,
                name: entry.name,
                model: new DeepSeekAgentModel({ auth: options.auth, modelId: entry.modelId }),
                modelProfile: { providerId: "deepseek", modelId: entry.modelId, contextWindowTokens: entry.contextWindowTokens },
                reasoningEfforts: entry.reasoningEfforts,
                defaultReasoningEffort: entry.defaultReasoningEffort,
                estimationPolicy: { reasoningHistory: "preserve", outputReserveTokens: entry.maxOutputTokens },
            })),
        },
    }
}
