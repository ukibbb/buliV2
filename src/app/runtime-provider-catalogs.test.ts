import { expect, test } from "bun:test"
import { BuliApplicationRuntime, type IBuliModelRuntimeConfig, type TProviderCatalogResult } from "./runtime"
import { InMemorySessionManager } from "@/sessions"

function model(id: string, providerId: string): IBuliModelRuntimeConfig {
    return {
        id, name: id, reasoningEfforts: ["high"], defaultReasoningEffort: "high",
        modelProfile: { providerId, modelId: id, contextWindowTokens: 10000 },
        estimationPolicy: { reasoningHistory: providerId === "kimi-coding" ? "preserve" : "omit" },
        model: { async *stream() { yield { type: "finish", reason: "stop" } } },
    }
}
const openAi = model("openai-model", "openai")
const kimi = model("kimi-model", "kimi-coding")
const ready = (entry: IBuliModelRuntimeConfig): TProviderCatalogResult => ({ providerId: entry.modelProfile!.providerId, status: "ready", models: [entry] })
const unavailable = (providerId: string, status: "error" | "disconnected"): TProviderCatalogResult => ({ providerId, status, message: "Synthetic catalog failure" })
function fixture(initial: readonly TProviderCatalogResult[]) {
    let results = initial
    const manager = new InMemorySessionManager()
    const runtime = new BuliApplicationRuntime({
        workspaceRoot: "/synthetic", manager,
        agents: [{ id: "agent", name: "Agent", systemPrompt: "System", tools: [] }], defaultAgentId: "agent",
        models: [openAi], selection: { modelId: openAi.id, reasoningEffort: "high" },
        preferredModelIds: [openAi.id], loadProviderCatalogs: async () => results,
    })
    return { runtime, manager, set: (next: readonly TProviderCatalogResult[]) => { results = next } }
}

test.each(["error", "disconnected"] as const)("Kimi stays selectable when OpenAI is %s; no automatic switch or prompt persistence", async (status) => {
    const { runtime, manager } = fixture([unavailable("openai", status), ready(kimi)])
    try {
        expect(runtime.getSnapshot().models).toEqual([])
        await runtime.refreshModels()
        expect(runtime.getSnapshot().models.map((entry) => entry.id)).toEqual([kimi.id])
        expect(runtime.getSnapshot().selection.modelId).toBe(openAi.id)
        expect(runtime.getSnapshot().selectedModelAvailable).toBe(false)
        expect(() => runtime.submitPrompt({ text: "Blocked" })).toThrow("Selected model unavailable")
        expect(manager.listSessions()).toEqual([])
        runtime.selectModel(kimi.id)
        expect(runtime.getSnapshot().selectedModelAvailable).toBe(true)
        await runtime.submitPrompt({ text: "Allowed" }).runFinished
    } finally { await runtime.dispose() }
})

test("errors retain only that provider's last good catalog; logout removes it and recovery does not switch provider", async () => {
    const { runtime, set } = fixture([ready(openAi), ready(kimi)])
    try {
        await runtime.refreshModels()
        set([unavailable("openai", "error"), ready(kimi)])
        await runtime.refreshModels()
        expect(runtime.getSnapshot().providerCatalogs?.[0]).toMatchObject({ status: "error", stale: true })
        expect(runtime.getSnapshot().selectedModelAvailable).toBe(true)
        set([unavailable("openai", "disconnected"), ready(kimi)])
        await runtime.refreshModels()
        expect(runtime.getSnapshot().selectedModelAvailable).toBe(false)
        expect(runtime.getSnapshot().models.map((entry) => entry.id)).toEqual([kimi.id])
        runtime.selectModel(kimi.id)
        set([ready(openAi), ready(kimi)])
        await runtime.refreshModels()
        expect(runtime.getSnapshot().selection.modelId).toBe(kimi.id)
        expect(runtime.getSnapshot().providerCatalogs?.every((entry) => !entry.stale)).toBe(true)
    } finally { await runtime.dispose() }
})

test("empty successful catalog removes selected model, blocks compaction and clears session context", async () => {
    const { runtime, set } = fixture([ready(openAi), ready(kimi)])
    try {
        await runtime.refreshModels()
        const run = runtime.submitPrompt({ text: "Hello" })
        await run.runFinished
        set([{ providerId: "openai", status: "ready", models: [] }, ready(kimi)])
        await runtime.refreshModels()
        expect(runtime.getSnapshot().selectedModelAvailable).toBe(false)
        expect(() => runtime.compactSession(run.sessionId)).toThrow("Selected model unavailable")
        expect(runtime.openSession(run.sessionId).getSnapshot().contextUsage?.contextWindowTokens).toBeUndefined()
        expect(runtime.getSnapshot().selection.modelId).toBe(openAi.id)
        runtime.selectModel(kimi.id)
        expect(runtime.getSnapshot().selectedModelAvailable).toBe(true)
    } finally { await runtime.dispose() }
})

test("same-provider fallback and initial preference remain available", async () => {
    const fast = { ...model("fast", "openai"), fallbackSelectionId: openAi.id }
    const { runtime, set } = fixture([{ providerId: "openai", status: "ready", models: [openAi, fast] }, ready(kimi)])
    try {
        await runtime.refreshModels()
        runtime.selectModel(fast.id)
        set([ready(openAi), ready(kimi)])
        await runtime.refreshModels()
        expect(runtime.getSnapshot().selection.modelId).toBe(openAi.id)
    } finally { await runtime.dispose() }
})

test("invalid provider result rejects atomically without corrupting the last good catalog", async () => {
    const { runtime, set } = fixture([ready(openAi), ready(kimi)])
    try {
        await runtime.refreshModels()
        const snapshot = runtime.getSnapshot()
        set([{ providerId: "openai", status: "ready", models: [kimi] }])
        await expect(runtime.refreshModels()).rejects.toThrow("foreign model")
        expect(runtime.getSnapshot()).toBe(snapshot)
    } finally { await runtime.dispose() }
})

test.each(["abort", "dispose"] as const)("%s prevents a late provider result from committing", async (mode) => {
    const pending = Promise.withResolvers<readonly TProviderCatalogResult[]>()
    const controller = new AbortController()
    const runtime = new BuliApplicationRuntime({
        workspaceRoot: "/synthetic", manager: new InMemorySessionManager(),
        agents: [{ id: "agent", name: "Agent", systemPrompt: "System", tools: [] }], defaultAgentId: "agent",
        models: [openAi], selection: { modelId: openAi.id, reasoningEffort: "high" },
        preferredModelIds: [openAi.id], loadProviderCatalogs: async () => pending.promise,
    })
    try {
        const result = runtime.refreshModels(controller.signal).then(() => false, () => true)
        if (mode === "abort") controller.abort()
        else await runtime.dispose()
        pending.resolve([ready(openAi), ready(kimi)])
        expect(await result).toBe(true)
        await Promise.resolve()
        expect(runtime.getSnapshot().models).toEqual([])
        expect(runtime.getSnapshot().selectedModelAvailable).toBe(false)
    } finally { pending.resolve([]); await runtime.dispose() }
})

test("active run retains its adapter after logout; new runs are blocked", async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let finished = false
    const active = { ...openAi, model: { async *stream() {
        started.resolve()
        await release.promise
        finished = true
        yield { type: "finish" as const, reason: "stop" }
    } } }
    const { runtime, set } = fixture([ready(active), ready(kimi)])
    try {
        await runtime.refreshModels()
        const run = runtime.submitPrompt({ text: "Start" })
        await started.promise
        set([unavailable("openai", "disconnected"), ready(kimi)])
        await runtime.refreshModels()
        expect(() => runtime.submitPrompt({ text: "Blocked" })).toThrow()
        release.resolve()
        await run.runFinished
        expect(finished).toBe(true)
    } finally { release.resolve(); await runtime.dispose() }
})
