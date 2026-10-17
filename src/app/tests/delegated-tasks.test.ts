import { expect, test } from "bun:test"
import { BuliApplicationRuntime } from "@/app/runtime"
import { AgentSession, SQLiteSessionManager } from "@/sessions"
import type { IAgentModelRequest } from "@/agent"
import { createExplorerAgentDefinition } from "@/agent/definitions/explorer"
import { EphemeralToolOutputStore } from "@/agent/tools"

test("Explorers run concurrently, isolate context, and return results in input order", async () => {
    const manager = new SQLiteSessionManager({ databasePath: ":memory:" })
    const started: IAgentModelRequest[] = []
    const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()]
    const allStarted = Promise.withResolvers<void>()
    let parentId = ""
    let resultText = ""
    const runtime = new BuliApplicationRuntime({
        workspaceRoot: process.cwd(), manager, defaultAgentId: "buli",
        agents: [
            { id: "buli", name: "Buli", systemPrompt: "parent", tools: [] },
            { id: "novibe", name: "NoVibe", systemPrompt: "", tools: [] },
        ],
        explorer: createExplorerAgentDefinition({ workspaceRoot: process.cwd(), toolOutputStore: new EphemeralToolOutputStore() }),
        selection: { modelId: "test", reasoningEffort: "high" },
        models: [{ id: "test", name: "Test", reasoningEfforts: ["high"], defaultReasoningEffort: "high",
            modelProfile: { providerId: "test", modelId: "test" },
            model: { async *stream(request) {
                if (request.systemPrompt === "parent") {
                    parentId = request.sessionId
                    const result = request.messages.find((message) => message.role === "toolResult")
                    if (!result) {
                        yield { type: "tool-call", toolCallId: "delegate", toolName: "delegate_task", input: { tasks: [{ task: "one" }, { task: "two" }, { task: "three" }] } }
                        yield { type: "finish", reason: "tool-calls" }
                    } else {
                        resultText = result.content
                        expect(request.messages.filter((message) => message.role === "user")).toHaveLength(1)
                        yield { type: "finish", reason: "stop" }
                    }
                } else {
                    const index = started.length
                    started.push(request)
                    if (started.length === 3) allStarted.resolve()
                    await gates[index]!.promise
                    yield { type: "text-start", id: "text" }
                    yield { type: "text-delta", id: "text", delta: `report-${index}` }
                    yield { type: "text-end", id: "text" }
                    yield { type: "finish", reason: "stop" }
                }
            } },
        }],
    })
    try {
        const novibe = runtime.createSession({ agentId: "novibe", title: "NoVibe" })
        expect((runtime.openSession(novibe.id) as AgentSession).state.tools.map((tool) => tool.name)).toContain("delegate_task")
        await runtime.closeSession(novibe.id)
        manager.openSession(novibe.id)
        manager.deleteSession(novibe.id)
        manager.releaseSession(novibe.id)
        const run = runtime.submitPrompt({ text: "parent secret" })
        await allStarted.promise
        expect(started).toHaveLength(3)
        for (const request of started) {
            expect(request.sessionId).not.toBe(parentId)
            expect(request.reasoningEffort).toBe("high")
            expect(JSON.stringify(request.messages)).not.toContain("parent secret")
            expect(request.tools.map((tool) => tool.name)).toEqual(["read", "find", "grep", "tool_output"])
        }
        const parentMessages = runtime.openSession(parentId).loadHistoryPage("main").messages
        const assistant = parentMessages.find((message) => message.role === "assistant")!
        const waitFor = (position: number) => new Promise<void>((resolve) => {
            const unsubscribe = runtime.delegatedTasks!.subscribe(() => {
                if (runtime.delegatedTasks!.list(parentId, assistant.id, "delegate")[position]?.status === "completed") {
                    unsubscribe()
                    resolve()
                }
            })
        })
        const third = waitFor(2)
        gates[2]!.resolve()
        await third
        expect(runtime.delegatedTasks!.list(parentId, assistant.id, "delegate").map((task) => task.status))
            .toEqual(["running", "running", "completed"])
        const first = waitFor(0)
        gates[0]!.resolve()
        await first
        gates[1]!.resolve()
        await run.runFinished
        expect(JSON.parse(resultText).results.map((result: { answer: string }) => result.answer)).toEqual(["report-0", "report-1", "report-2"])
        expect(runtime.listSessions()).toHaveLength(1)
        const tasks = runtime.delegatedTasks!.list(parentId, assistant.id, "delegate")
        expect(tasks.every((task) => task.status === "completed")).toBe(true)
        manager.deleteSession(parentId)
        for (const task of tasks) expect(manager.getSessionInfo(task.childSessionId)).toBeUndefined()
    } finally {
        for (const gate of gates) gate.resolve()
        await runtime.dispose()
    }
})
