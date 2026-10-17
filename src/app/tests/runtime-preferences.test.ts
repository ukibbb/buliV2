import { expect, test } from "bun:test"
import type { IBuliModelSelection } from "@/app/contracts"
import { BuliApplicationRuntime, type IBuliModelRuntimeConfig, type IBuliRuntimeOptions } from "@/app/runtime"
import { SQLiteSessionManager } from "@/sessions"

function model(id: string, providerId: string): IBuliModelRuntimeConfig {
    return {
        id, name: id, modelProfile: { providerId, modelId: id },
        reasoningEfforts: ["medium", "high"], defaultReasoningEffort: "medium",
        model: { async *stream() { yield { type: "finish", reason: "stop" } } },
    }
}

function runtime(options: Partial<IBuliRuntimeOptions> = {}) {
    return new BuliApplicationRuntime({
        workspaceRoot: "/workspace", manager: new SQLiteSessionManager({ databasePath: ":memory:" }),
        agents: [{ id: "agent", name: "Agent", systemPrompt: "System", tools: [] }],
        defaultAgentId: "agent", models: [model("default", "openai")],
        selection: { modelId: "default", reasoningEffort: "medium" },
        preferredModelIds: ["default"],
        loadProviderCatalogs: async () => [{ providerId: "openai", status: "ready", models: [model("default", "openai")] }],
        ...options,
    })
}

for (const providerId of ["openai", "kimi-coding", "deepseek"]) {
    test(`restores ${providerId} without saving during discovery`, async () => {
        const saved: IBuliModelSelection[] = []
        const selection = { modelId: "saved", reasoningEffort: "high" as const }
        const app = runtime({ restoredSelection: selection, saveModelSelection: (value) => saved.push(value),
            loadProviderCatalogs: async () => [{ providerId, status: "ready", models: [model("saved", providerId)] }],
        })
        try {
            expect(() => app.submitPrompt({ text: "before discovery" })).toThrow()
            await app.refreshModels()
            expect(app.getSnapshot().selection).toEqual(selection)
            expect(app.getSnapshot().selectedModelAvailable).toBe(true)
            expect(saved).toEqual([])
            app.selectReasoningEffort("high")
            expect(saved).toEqual([selection])
        } finally { await app.dispose() }
    })
}

test("missing restored model stays selected until it returns or user chooses another", async () => {
    let available = false
    const app = runtime({ restoredSelection: { modelId: "saved", reasoningEffort: "high" },
        loadProviderCatalogs: async () => [{ providerId: "openai", status: "ready", models: [model("default", "openai"), ...(available ? [model("saved", "openai")] : [])] }],
    })
    try {
        await app.refreshModels()
        expect(app.getSnapshot().selection.modelId).toBe("saved")
        expect(() => app.submitPrompt({ text: "blocked" })).toThrow("unavailable")
        available = true
        await app.refreshModels()
        expect(app.getSnapshot().selection).toEqual({ modelId: "saved", reasoningEffort: "high" })
        available = false
        await app.refreshModels()
        expect(app.getSnapshot().selection.modelId).toBe("saved")
        expect(app.getSnapshot().selectedModelAvailable).toBe(false)
        app.selectModel("default")
        expect(app.getSnapshot().selectedModelAvailable).toBe(true)
    } finally { await app.dispose() }
})

test("unsupported restored reasoning uses default with warning without saving", async () => {
    const saved: IBuliModelSelection[] = []
    const app = runtime({ restoredSelection: { modelId: "default", reasoningEffort: "max" }, saveModelSelection: (value) => saved.push(value) })
    try {
        await app.refreshModels()
        expect(app.getSnapshot().selection.reasoningEffort).toBe("medium")
        expect(app.getSnapshot().preferencesWarning).toContain('Saved reasoning "max"')
        await app.refreshModels()
        expect(app.getSnapshot().preferencesWarning).toBeDefined()
        expect(saved).toEqual([])
        app.selectReasoningEffort("medium")
        expect(app.getSnapshot().preferencesWarning).toBeUndefined()
        expect(saved).toHaveLength(1)
    } finally { await app.dispose() }
})

test("failed save leaves snapshot unchanged; successful changes save complete pairs", async () => {
    let fail = true
    const saved: IBuliModelSelection[] = []
    const app = runtime({ preferencesWarning: "Read failed", saveModelSelection: (value) => {
        if (fail) throw new Error("disk failure")
        saved.push(value)
    } })
    try {
        await app.refreshModels()
        const before = app.getSnapshot()
        expect(() => app.selectReasoningEffort("high")).toThrow("disk failure")
        expect(app.getSnapshot()).toBe(before)
        fail = false
        app.selectReasoningEffort("high")
        expect(saved).toEqual([{ modelId: "default", reasoningEffort: "high" }])
        expect(app.getSnapshot().preferencesWarning).toBeUndefined()
        app.selectModel("default")
        expect(saved).toHaveLength(2)
    } finally { await app.dispose() }
})
