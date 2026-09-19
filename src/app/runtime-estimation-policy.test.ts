import { expect, test } from "bun:test"
import { BuliApplicationRuntime, type IBuliModelRuntimeConfig } from "@/app/runtime"
import { InMemorySessionManager } from "@/sessions"

function createRuntime(registration: IBuliModelRuntimeConfig): BuliApplicationRuntime {
    const manager = new InMemorySessionManager()
    manager.createSession({ id: "session", agentId: "agent", title: "Test", createdAt: 1, updatedAt: 1 })
    manager.appendMessage({
        id: "answer", sessionId: "session", runId: "old", role: "assistant",
        content: [{ type: "reasoning", text: "R".repeat(20_000) }], stopReason: "stop", createdAt: 2,
    })
    return new BuliApplicationRuntime({
        workspaceRoot: "/workspace", manager,
        agents: [{ id: "agent", name: "Agent", systemPrompt: "System", tools: [] }],
        defaultAgentId: "agent", models: [registration],
        selection: { modelId: registration.id, reasoningEffort: "high" },
    })
}

const base: IBuliModelRuntimeConfig = {
    id: "model", name: "Model", model: { async *stream() {} },
    reasoningEfforts: ["high"], defaultReasoningEffort: "high",
}

test("runtime forwards an isolated estimation policy to sessions", async () => {
    const policy: { reasoningHistory: "omit" | "preserve" } = { reasoningHistory: "preserve" }
    const runtime = createRuntime({ ...base, estimationPolicy: policy })
    policy.reasoningHistory = "omit"
    try {
        expect(runtime.openSession("session").getSnapshot().contextUsage!.estimatedInputTokens).toBeGreaterThan(10_000)
    } finally { await runtime.dispose() }
})

test("runtime without a policy preserves the existing omit behavior", async () => {
    const runtime = createRuntime(base)
    try {
        expect(runtime.openSession("session").getSnapshot().contextUsage!.estimatedInputTokens).toBeLessThan(1_000)
    } finally { await runtime.dispose() }
})

test("runtime captures the output reserve without sharing mutable policy", async () => {
    const policy = { reasoningHistory: "preserve" as const, outputReserveTokens: 393_216 }
    const runtime = createRuntime({ ...base, estimationPolicy: policy,
        modelProfile: { providerId: "deepseek", modelId: "deepseek-flash", contextWindowTokens: 1_048_576 },
    })
    policy.outputReserveTokens = 1
    try {
        expect(runtime.openSession("session").getSnapshot().contextUsage!.compactionThresholdTokens).toBe(655_360)
    } finally { await runtime.dispose() }
})

for (const outputReserveTokens of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 1_048_576]) {
    test(`runtime rejects invalid output reserve ${outputReserveTokens}`, () => {
        expect(() => createRuntime({ ...base,
            modelProfile: { providerId: "test", modelId: "test", contextWindowTokens: 1_048_576 },
            estimationPolicy: { reasoningHistory: "preserve", outputReserveTokens },
        })).toThrow("Invalid context output reserve")
    })
}

for (const invalid of [null, {}, { reasoningHistory: "invalid" }]) {
    test(`runtime rejects invalid policy ${JSON.stringify(invalid)}`, () => {
        expect(() => createRuntime({
            ...base,
            estimationPolicy: invalid as unknown as NonNullable<IBuliModelRuntimeConfig["estimationPolicy"]>,
        })).toThrow("Invalid context estimation policy")
    })
}
