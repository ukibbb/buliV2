import { expect, mock, test } from "bun:test"
import type { IAgentModel } from "@/agent"
import { createInjectedModelComposition } from "@/app/bootstrap/model-composition"
import { createOpenAiModelComposition } from "@/app/bootstrap/create-openai-model-composition"
import type { IOpenAiAuth, IOpenAiCatalogModel } from "@/providers/openai"

function authFixture() {
    const unexpected = mock(async (): Promise<never> => {
        throw new Error("Unexpected auth or transport call")
    })
    const transport = Object.assign(unexpected, { preconnect: () => undefined })
    const auth = {
        id: "openai",
        name: "OpenAI",
        methods: [],
        status: unexpected,
        login: unexpected,
        logout: unexpected,
        dispose: unexpected,
        getCredential: unexpected,
        requireCredential: unexpected,
        refreshAfterUnauthorized: unexpected,
        authenticatedFetch: transport,
        authenticatedFetchForAccount: () => transport,
        fetchModels: unexpected,
        search: unexpected,
    } satisfies IOpenAiAuth
    return { auth, unexpected }
}

test("injected composition retains defaults without provider metadata or discovery", () => {
    const model: IAgentModel = {
        async *stream() { yield { type: "finish", reason: "stop" } },
    }
    const composition = createInjectedModelComposition(model)
    expect(composition.models).toEqual([{
        id: "gpt-6-astra",
        name: "Injected model",
        model,
        reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
        defaultReasoningEffort: "medium",
    }])
    expect(composition.selection).toEqual({ modelId: "gpt-6-astra", reasoningEffort: "medium" })
    expect(composition.additionalTools).toEqual([])
    expect(composition).not.toHaveProperty("discovery")
})

test.each([true, false])("OpenAI composition creates web search only when enabled: %s", (includeWebSearch) => {
    const { auth, unexpected } = authFixture()
    const load = mock(async () => [])
    const composition = createOpenAiModelComposition({ auth, catalog: { load }, includeWebSearch })
    expect(composition.additionalTools.map((tool) => tool.name)).toEqual(includeWebSearch ? ["web_search"] : [])
    expect(composition.selection).toEqual({ modelId: "gpt-6-astra", reasoningEffort: "low" })
    expect(composition.discovery?.preferredModelIds).toEqual(["gpt-6-astra::fast", "gpt-6-astra"])
    expect(composition.models[0]?.modelProfile).toEqual({ providerId: "openai", modelId: "gpt-6-astra" })
    expect(load).not.toHaveBeenCalled()
    expect(unexpected).not.toHaveBeenCalled()
})

test("discovery forwards cancellation and preserves account, Fast fallback and unknown context", async () => {
    const { auth, unexpected } = authFixture()
    const standard: IOpenAiCatalogModel = {
        id: "account-model",
        modelId: "account-model",
        accountId: "synthetic-account",
        name: "Account model",
        reasoningEfforts: ["high"],
        defaultReasoningEffort: "high",
        supportsReasoning: true,
    }
    const fast: IOpenAiCatalogModel = {
        ...standard,
        id: "account-model::fast",
        name: "Account model Fast",
        serviceTier: "priority",
        contextWindowTokens: 272_000,
    }
    const load = mock(async (_signal?: AbortSignal) => [standard, fast])
    const composition = createOpenAiModelComposition({ auth, catalog: { load }, includeWebSearch: false })
    const signal = new AbortController().signal
    if (!composition.discovery) throw new Error("Expected discovery")
    const registrations = await composition.discovery.loadModels(signal)
    expect(load).toHaveBeenCalledWith(signal)
    expect(registrations).toHaveLength(2)
    expect(registrations[0]).toMatchObject({
        id: standard.id,
        name: standard.name,
        providerAccountId: standard.accountId,
        modelProfile: { providerId: "openai", modelId: standard.modelId },
        reasoningEfforts: ["high"],
        defaultReasoningEffort: "high",
    })
    expect(registrations[0]).not.toHaveProperty("fallbackSelectionId")
    expect(registrations[0]?.modelProfile).not.toHaveProperty("contextWindowTokens")
    expect(registrations[1]).toMatchObject({
        id: fast.id,
        providerAccountId: fast.accountId,
        fallbackSelectionId: standard.id,
        modelProfile: { providerId: "openai", modelId: standard.modelId, contextWindowTokens: 272_000 },
    })
    expect(unexpected).not.toHaveBeenCalled()
})
