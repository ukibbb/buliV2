import type { IAuthenticationComposition } from "./create-authentication"
import { createOpenAiModelComposition } from "./create-openai-model-composition"
import { createDeepSeekModelComposition } from "./create-deepseek-model-composition"
import type { IDeepSeekModelCatalog } from "@/providers/deepseek"
import { createKimiModelComposition } from "./create-kimi-model-composition"
import type { IOpenAiModelCatalog } from "@/providers/openai"
import type { IKimiModelCatalog } from "@/providers/kimi"
import type { TProviderCatalogLoader, TProviderCatalogResult } from "@/app/runtime"
import type { IAuthStatus } from "@/authentication"

export function createProviderModelComposition(options: {
    readonly auth: IAuthenticationComposition
    readonly openAiCatalog?: IOpenAiModelCatalog
    readonly kimiCatalog?: IKimiModelCatalog
    readonly deepseekCatalog?: IDeepSeekModelCatalog
    readonly includeWebSearch: boolean
}) {
    const openAi = createOpenAiModelComposition({
        auth: options.auth.openAi,
        ...(options.openAiCatalog ? { catalog: options.openAiCatalog } : {}),
        includeWebSearch: options.includeWebSearch,
    })
    const kimi = createKimiModelComposition({
        auth: options.auth.kimi,
        ...(options.kimiCatalog ? { catalog: options.kimiCatalog } : {}),
    })
    const deepseek = createDeepSeekModelComposition({
        auth: options.auth.deepseek,
        ...(options.deepseekCatalog ? { catalog: options.deepseekCatalog } : {}),
    })
    const providers = [
        { id: "openai", auth: options.auth.openAi, composition: openAi },
        { id: "kimi-coding", auth: options.auth.kimi, composition: kimi },
        { id: "deepseek", auth: options.auth.deepseek, composition: deepseek },
    ]
    const loadProviderCatalogs: TProviderCatalogLoader = async (signal) => {
        const results = await Promise.all(providers.map(async (provider): Promise<TProviderCatalogResult> => {
            try {
                signal.throwIfAborted()
                const status: IAuthStatus = await provider.auth.status(signal)
                signal.throwIfAborted()
                if (!status.connected) return { providerId: provider.id, status: "disconnected", message: `${provider.id}: sign in to discover models.` }
                const discovery = provider.composition.discovery
                if (!discovery) throw new Error("Missing provider discovery")
                const models = await discovery.loadModels(signal)
                const latestStatus = await provider.auth.status(signal)
                signal.throwIfAborted()
                if (!latestStatus.connected) return { providerId: provider.id, status: "disconnected", message: `${provider.id}: sign in to discover models.` }
                return { providerId: provider.id, status: "ready", models }
            } catch {
                signal.throwIfAborted()
                return { providerId: provider.id, status: "error", message: `${provider.id}: model catalog discovery failed; retry after checking authentication and connectivity.` }
            }
        }))
        signal.throwIfAborted()
        return results
    }
    return {
        models: openAi.models,
        selection: openAi.selection,
        additionalTools: openAi.additionalTools,
        discovery: {
            preferredModelIds: openAi.discovery?.preferredModelIds ?? [],
            loadProviderCatalogs,
        },
    }
}
