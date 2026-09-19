import type { IModelComposition } from "@/app/bootstrap/model-composition"
import { createOpenAiSearchBackend } from "@/app/bootstrap/create-openai-search-backend"
import type { IBuliModelRuntimeConfig } from "@/app/runtime"
import {
    DEFAULT_OPENAI_MODEL_ID,
    DEFAULT_OPENAI_REASONING_EFFORTS,
    OPENAI_PROVIDER_ID,
    OpenAiAgentModel,
    createOpenAiModelCatalog,
    createOpenAiWebSearchTool,
    type IOpenAiAuth,
    type IOpenAiModelCatalog,
} from "@/providers/openai"

interface IOpenAiModelCompositionOptions {
    readonly auth: IOpenAiAuth
    readonly catalog?: IOpenAiModelCatalog
    readonly includeWebSearch: boolean
}

export function createOpenAiModelComposition(
    options: IOpenAiModelCompositionOptions,
): IModelComposition {
    const { auth } = options
    const catalog = options.catalog ?? createOpenAiModelCatalog({ auth })
    const defaultReasoningEffort = DEFAULT_OPENAI_REASONING_EFFORTS[0]
    return {
        models: [{
            id: DEFAULT_OPENAI_MODEL_ID,
            name: "GPT-6 Astra",
            model: new OpenAiAgentModel({ auth }),
            modelProfile: {
                providerId: OPENAI_PROVIDER_ID,
                modelId: DEFAULT_OPENAI_MODEL_ID,
            },
            reasoningEfforts: DEFAULT_OPENAI_REASONING_EFFORTS,
            defaultReasoningEffort,
        }],
        selection: {
            modelId: DEFAULT_OPENAI_MODEL_ID,
            reasoningEffort: defaultReasoningEffort,
        },
        additionalTools: options.includeWebSearch
            ? [createOpenAiWebSearchTool({
                resolveBackend: createOpenAiSearchBackend({ auth, catalog }),
            })]
            : [],
        discovery: {
            preferredModelIds: [`${DEFAULT_OPENAI_MODEL_ID}::fast`, DEFAULT_OPENAI_MODEL_ID],
            loadModels: async (signal) => (
                await catalog.load(signal)
            ).map((entry): IBuliModelRuntimeConfig => ({
                id: entry.id,
                name: entry.name,
                model: new OpenAiAgentModel({
                    auth,
                    modelId: entry.modelId,
                    expectedAccountId: entry.accountId,
                    ...(entry.supportsReasoning === undefined
                        ? {}
                        : { supportsReasoning: entry.supportsReasoning }),
                    ...(entry.serviceTier === undefined
                        ? {}
                        : { serviceTier: entry.serviceTier }),
                }),
                modelProfile: {
                    providerId: OPENAI_PROVIDER_ID,
                    modelId: entry.modelId,
                    ...(entry.contextWindowTokens === undefined
                        ? {}
                        : { contextWindowTokens: entry.contextWindowTokens }),
                },
                providerAccountId: entry.accountId,
                ...(entry.serviceTier === undefined
                    ? {}
                    : { fallbackSelectionId: entry.modelId }),
                reasoningEfforts: entry.reasoningEfforts,
                defaultReasoningEffort: entry.defaultReasoningEffort,
            })),
        },
    }
}
