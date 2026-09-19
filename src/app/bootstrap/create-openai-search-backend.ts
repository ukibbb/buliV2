import {
    DEFAULT_OPENAI_MODEL_ID,
    type IOpenAiAuth,
    type IOpenAiModelCatalog,
} from "@/providers/openai"
import type { IOpenAiWebSearchToolOptions } from "@/providers/openai"

export function createOpenAiSearchBackend(options: {
    readonly auth: Pick<IOpenAiAuth, "search">
    readonly catalog: IOpenAiModelCatalog
}): IOpenAiWebSearchToolOptions["resolveBackend"] {
    return async (signal) => {
        signal.throwIfAborted()
        const entries = await options.catalog.load(signal)
        signal.throwIfAborted()
        const entry = entries.find((candidate) => (
            candidate.modelId === DEFAULT_OPENAI_MODEL_ID
            && candidate.serviceTier === undefined
        )) ?? entries.find((candidate) => candidate.serviceTier === undefined)
            ?? entries[0]
        if (!entry) throw new Error("No OpenAI model available for web search")
        return {
            modelId: entry.modelId,
            search: (request, searchOptions) => options.auth.search(request, {
                ...searchOptions,
                expectedAccountId: entry.accountId,
            }),
        }
    }
}
