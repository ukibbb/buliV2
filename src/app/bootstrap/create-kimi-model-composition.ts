import type { IModelComposition } from "@/app/bootstrap/model-composition"
import type { IBuliModelRuntimeConfig } from "@/app/runtime"
import { KimiAgentModel } from "@/providers/kimi"
import { createKimiModelCatalog, type IKimiModelCatalog } from "@/providers/kimi"

interface IKimiModelCompositionOptions {
    readonly auth: { readonly authenticatedFetch: typeof fetch }
    readonly catalog?: IKimiModelCatalog
}

export function createKimiModelComposition(options: IKimiModelCompositionOptions): IModelComposition {
    const catalog = options.catalog ?? createKimiModelCatalog({ auth: options.auth })
    const defaultId = "kimi-coding/kimi-for-coding"
    return {
        models: [{
            id: defaultId,
            name: "Kimi Code · kimi-for-coding",
            model: new KimiAgentModel({ auth: options.auth, modelId: "kimi-for-coding" }),
            modelProfile: { providerId: "kimi-coding", modelId: "kimi-for-coding" },
            reasoningEfforts: ["low", "high", "max"],
            defaultReasoningEffort: "max",
            estimationPolicy: { reasoningHistory: "preserve" },
        }],
        selection: { modelId: defaultId, reasoningEffort: "max" },
        additionalTools: [],
        discovery: {
            preferredModelIds: [defaultId],
            loadModels: async (signal) => (await catalog.load(signal)).map((entry): IBuliModelRuntimeConfig => ({
                id: `kimi-coding/${entry.modelId}`,
                name: entry.name,
                model: new KimiAgentModel({ auth: options.auth, modelId: entry.modelId }),
                modelProfile: {
                    providerId: "kimi-coding",
                    modelId: entry.modelId,
                    ...(entry.contextWindowTokens === undefined ? {} : { contextWindowTokens: entry.contextWindowTokens }),
                },
                reasoningEfforts: entry.reasoningEfforts,
                defaultReasoningEffort: entry.defaultReasoningEffort,
                estimationPolicy: { reasoningHistory: "preserve" },
            })),
        },
    }
}
