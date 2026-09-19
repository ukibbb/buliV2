import { expect, test } from "bun:test"
import { contextCompactionThresholdTokens, estimateContextUsage, shouldCompactContext } from "./context-budget"
import { compactSessionMessages } from "./session-compactor"
import type { IAgentModel } from "@/agent"

const policy = { reasoningHistory: "preserve", outputReserveTokens: 393_216 } as const

test("explicit reserve lowers only the applicable context threshold", () => {
    expect(contextCompactionThresholdTokens(1_048_576, policy)).toBe(655_360)
    expect(contextCompactionThresholdTokens(1_048_576)).toBe(838_861)
    expect(shouldCompactContext(655_359, 1_048_576, policy)).toBe(false)
    expect(shouldCompactContext(655_360, 1_048_576, policy)).toBe(true)
    const input = { systemPrompt: "", messages: [], tools: [], estimationPolicy: policy }
    expect(estimateContextUsage(input, 1_048_576).compactionThresholdTokens).toBe(655_360)
    expect(estimateContextUsage(input).shouldCompact).toBe(false)
})

test("summarizer uses the captured reserve while default models retain their budget", async () => {
    let requests = 0
    const model: IAgentModel = { async *stream() {
        requests += 1
        yield { type: "text-delta", id: "summary", delta: "Summary" }
        yield { type: "finish", reason: "stop" }
    } }
    const options = {
        sessionId: "session", reason: "manual" as const,
        messages: [{ id: "answer", sessionId: "session", runId: "run", role: "assistant" as const,
            content: [{ type: "text" as const, text: "x".repeat(1_400_000) }], stopReason: "stop" as const, createdAt: 1 }],
        runConfiguration: { model, reasoningEffort: "high" as const,
            modelProfile: { providerId: "test", modelId: "test", contextWindowTokens: 1_048_576 } },
        signal: new AbortController().signal, now: () => 2, generateId: () => "checkpoint",
    }
    await expect(compactSessionMessages({ ...options,
        runConfiguration: { ...options.runConfiguration, estimationPolicy: policy },
    })).rejects.toThrow("655360-token input budget with a 393216-token output headroom")
    expect(requests).toBe(0)
    expect(await compactSessionMessages(options)).toMatchObject({ summary: "Summary" })
    expect(requests).toBe(1)
})
