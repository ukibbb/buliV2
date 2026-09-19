import { expect, mock, test } from "bun:test"
import { createOpenAiSearchBackend } from "@/app/bootstrap/create-openai-search-backend"
import type { IOpenAiCatalogModel } from "@/providers/openai"
import type { TOpenAiCodexSearch } from "@/providers/openai/transport/codex-fetch"

function entry(modelId: string, accountId = "openai-account"): IOpenAiCatalogModel {
    return { id: modelId, modelId, accountId, name: modelId, reasoningEfforts: ["low"], defaultReasoningEffort: "low" }
}

test("resolves lazily, prefers Standard and binds search to the catalog account", async () => {
    const standard = entry("gpt-6-astra")
    const load = mock(async (_signal?: AbortSignal) => [
        entry("other-model"),
        { ...standard, id: "gpt-6-astra::fast", serviceTier: "priority" as const },
        standard,
    ])
    const search = mock<TOpenAiCodexSearch>(async () => ({ output: "Found" }))
    const resolve = createOpenAiSearchBackend({ catalog: { load }, auth: { search } })
    expect(load).not.toHaveBeenCalled()
    const signal = new AbortController().signal
    const backend = await resolve(signal)
    expect(load).toHaveBeenCalledWith(signal)
    expect(backend.modelId).toBe("gpt-6-astra")
    await backend.search({ model: backend.modelId }, { signal, expectedAccountId: "wrong-account" })
    expect(search).toHaveBeenCalledWith({ model: "gpt-6-astra" }, { signal, expectedAccountId: "openai-account" })
})

test("uses a catalog model without inventing availability", async () => {
    const resolve = createOpenAiSearchBackend({
        catalog: { load: async () => [entry("account-only-model")] },
        auth: { search: async () => ({ output: "Found" }) },
    })
    expect((await resolve(new AbortController().signal)).modelId).toBe("account-only-model")
})

test("missing auth, empty catalog and cancellation reject without search", async () => {
    const search = mock<TOpenAiCodexSearch>(async () => ({ output: "unexpected" }))
    const failure = new Error("OpenAI is not connected")
    const unavailable = createOpenAiSearchBackend({
        catalog: { load: async () => { throw failure } }, auth: { search },
    })
    await expect(unavailable(new AbortController().signal)).rejects.toBe(failure)
    const empty = createOpenAiSearchBackend({ catalog: { load: async () => [] }, auth: { search } })
    await expect(empty(new AbortController().signal)).rejects.toThrow("No OpenAI model")
    const controller = new AbortController()
    const reason = new Error("Cancelled")
    const cancelled = createOpenAiSearchBackend({
        catalog: { load: async () => { controller.abort(reason); return [entry("model")] } },
        auth: { search },
    })
    await expect(cancelled(controller.signal)).rejects.toBe(reason)
    expect(search).not.toHaveBeenCalled()
})

test("refreshes backend account between resolutions and propagates account-change rejection", async () => {
    let accountId = "old-account"
    const failure = new Error("OpenAI account changed")
    const search = mock<TOpenAiCodexSearch>(async (_request, options) => {
        if (options?.expectedAccountId !== accountId) throw failure
        return { output: "Found" }
    })
    const resolve = createOpenAiSearchBackend({
        catalog: { load: async () => [entry("model", accountId)] }, auth: { search },
    })
    const signal = new AbortController().signal
    const oldBackend = await resolve(signal)
    accountId = "new-account"
    await expect(oldBackend.search({}, { signal })).rejects.toBe(failure)
    const newBackend = await resolve(signal)
    await expect(newBackend.search({}, { signal })).resolves.toEqual({ output: "Found" })
})
