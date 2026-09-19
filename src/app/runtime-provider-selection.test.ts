import { expect, test } from "bun:test"
import { BuliApplicationRuntime, type IBuliModelRuntimeConfig } from "@/app/runtime"
import { InMemorySessionManager } from "@/sessions"

function registration(id: string, providerId?: string): IBuliModelRuntimeConfig {
    return {
        id, name: id, reasoningEfforts: ["high"], defaultReasoningEffort: "high",
        ...(providerId === undefined ? {} : { modelProfile: { providerId, modelId: id } }),
        model: { async *stream() { yield { type: "finish", reason: "stop" } } },
    }
}

function runtimeFor(initial: IBuliModelRuntimeConfig, loadModels: () => Promise<readonly IBuliModelRuntimeConfig[]>, startup = false) {
    return new BuliApplicationRuntime({
        workspaceRoot: "/workspace", manager: new InMemorySessionManager(),
        agents: [{ id: "agent", name: "Agent", systemPrompt: "System", tools: [] }],
        defaultAgentId: "agent", models: [initial], loadModels,
        selection: { modelId: initial.id, reasoningEffort: "high" },
        ...(startup ? { preferredModelIds: [initial.id, "foreign"] } : {}),
    })
}

for (const startup of [false, true]) {
    test(`filters foreign candidates and preferences (startup=${startup})`, async () => {
        const runtime = runtimeFor(registration("old", "openai"), async () => [
            registration("foreign", "kimi-coding"), registration("replacement", "openai"),
        ], startup)
        try {
            await runtime.refreshModels()
            expect(runtime.getSnapshot().selection.modelId).toBe("replacement")
            runtime.selectModel("foreign")
            expect(runtime.getSnapshot().selection.modelId).toBe("foreign")
        } finally { await runtime.dispose() }
    })

    test(`rejects foreign-only catalog without executing its adapter (startup=${startup})`, async () => {
        let foreignCalls = 0
        const foreign = { ...registration("foreign", "kimi-coding"), model: {
            async *stream() { foreignCalls += 1; yield { type: "finish" as const, reason: "stop" } },
        } }
        const runtime = runtimeFor(registration("old", "openai"), async () => [foreign], startup)
        try {
            await expect(runtime.refreshModels()).rejects.toThrow("Automatic provider switching is disabled")
            expect(runtime.getSnapshot().selection.modelId).toBe("old")
            if (startup) {
                expect(runtime.getSnapshot().modelCatalog?.status).toBe("error")
                expect(() => runtime.submitPrompt({ text: "Hello" })).toThrow()
            } else {
                expect(runtime.getSnapshot().models.map((model) => model.id)).toEqual(["old"])
                await runtime.submitPrompt({ text: "Hello" }).runFinished
            }
            expect(foreignCalls).toBe(0)
        } finally { await runtime.dispose() }
    })
}

for (const [oldProvider, newProvider, newId] of [
    [undefined, "openai", "new"], ["openai", undefined, "new"],
    [undefined, undefined, "new"], ["openai", "kimi-coding", "old"],
    ["openai", undefined, "old"], ["", "", "new"],
] as const) {
    test(`rejects unsafe replacement ${oldProvider}/${newProvider}/${newId}`, async () => {
        const runtime = runtimeFor(registration("old", oldProvider), async () => [registration(newId, newProvider)])
        try {
            await expect(runtime.refreshModels()).rejects.toThrow("Automatic provider switching is disabled")
            expect(runtime.getSnapshot().selection.modelId).toBe("old")
        } finally { await runtime.dispose() }
    })
}

for (const provider of [undefined, "kimi-coding"]) {
    test(`rejects explicit fallback with provider ${provider}`, async () => {
        const runtime = runtimeFor(registration("old", "openai"), async () => [
            { ...registration("old", "openai"), fallbackSelectionId: "fallback" },
            registration("fallback", provider),
        ])
        try {
            await expect(runtime.refreshModels()).rejects.toThrow("same known provider")
        } finally { await runtime.dispose() }
    })
}

test("active run retains its adapter when a foreign-only refresh is rejected", async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let completed = false
    const initial = { ...registration("old", "openai"), model: {
        async *stream() {
            started.resolve()
            await release.promise
            completed = true
            yield { type: "finish" as const, reason: "stop" }
        },
    } }
    const runtime = runtimeFor(initial, async () => [registration("foreign", "kimi-coding")])
    try {
        const run = runtime.submitPrompt({ text: "Hello" })
        await started.promise
        await expect(runtime.refreshModels()).rejects.toThrow("Automatic provider switching is disabled")
        release.resolve()
        await run.runFinished
        expect(completed).toBe(true)
        expect(runtime.getSnapshot().selection.modelId).toBe("old")
    } finally {
        release.resolve()
        await runtime.dispose()
    }
})
