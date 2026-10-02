import { expect, spyOn, test } from "bun:test"
import {
    defineAgentTool,
    runAgentLoop,
    type IAgentInputQueue,
    type IAgentModel,
    type IAgentModelRequest,
    type IAgentToolContext,
    type IAssistantMessage,
    type IUserPathReference,
    type TAgentEvent,
    type TAgentModelEvent,
    type IUserMessage,
} from "@/agent"
import { AgentWorkingContext } from "@/sessions/agent-working-context"
import { HISTORY_MESSAGE_TARGET } from "@/sessions/history-contracts"
import { SQLiteSessionManager } from "@/sessions/sqlite/sqlite-session-manager"

const SESSION_ID = "context-session"
const RUN_ID = "context-run"
const TOOL_NAME = "inspect"
const SUMMARY = "Complete summary 🐂\n".repeat(2_000)

/** This fixture owns persistence/acceptance explicitly; it does not exercise AgentSession yet. */
async function withHistory(run: (manager: SQLiteSessionManager) => Promise<void>): Promise<void> {
    const manager = new SQLiteSessionManager({ databasePath: ":memory:" })
    try {
        manager.createSession({ id: SESSION_ID, agentId: "buli", title: "Context", createdAt: 1, updatedAt: 1 })
        await run(manager)
    } finally {
        manager.dispose()
    }
}

function user(id: string): IUserMessage {
    return { id, sessionId: SESSION_ID, runId: RUN_ID, role: "user", source: "prompt", content: id, createdAt: 2 }
}

function assistant(id: string): IAssistantMessage {
    return { id, sessionId: SESSION_ID, runId: RUN_ID, role: "assistant", content: [{ type: "text", text: id }], stopReason: "stop", createdAt: 3 }
}

function saveCheckpoint(manager: SQLiteSessionManager, throughMessageId: string, compactedMessageCount: number): void {
    manager.saveCompactionCheckpoint({ id: `checkpoint-${throughMessageId}`, sessionId: SESSION_ID,
        throughMessageId, compactedMessageCount, summary: SUMMARY, createdAt: 4, reason: "manual" })
}

function modelWithRequests(script: (turn: number) => readonly TAgentModelEvent[] = () => [{ type: "finish", reason: "stop" }]) {
    const requests: IAgentModelRequest[] = []
    const model: IAgentModel = {
        async *stream(request) {
            const turn = requests.length
            requests.push(request)
            yield* script(turn)
        },
    }
    return { model, requests }
}

function loopOptions(model: IAgentModel, emit: (event: TAgentEvent) => void | Promise<void>) {
    let nextId = 0
    return { sessionId: SESSION_ID, runId: RUN_ID, model, emit,
        reasoningEffort: "high" as const, signal: new AbortController().signal,
        generateId: () => `generated-${++nextId}`, now: () => 5 }
}

function acceptMessage(manager: SQLiteSessionManager, owner: AgentWorkingContext, event: TAgentEvent): void {
    if (event.type !== "message_end") return
    const result = manager.appendMessage(event.message)
    if (result.kind === "inserted") owner.acceptCommittedMessage(event.message)
    else owner.replaceContext(manager.loadRequiredContext(SESSION_ID))
}

for (const checkpointKind of ["absent", "usable", "unprocessed-user"] as const) {
    test(`loop request keeps all 1050 messages with ${checkpointKind} checkpoint, independently of the UI page`, async () => withHistory(async (manager) => {
        if (checkpointKind === "usable") {
            manager.appendMessage(user("compacted-user"))
            manager.appendMessage(assistant("compacted-answer"))
            saveCheckpoint(manager, "compacted-answer", 2)
        }
        for (let index = 0; index < 1_050; index++) manager.appendMessage(user(`history-${index}`))
        if (checkpointKind === "unprocessed-user") saveCheckpoint(manager, "history-1049", 1_050)
        const owner = new AgentWorkingContext(manager.loadRequiredContext(SESSION_ID))
        const { model, requests } = modelWithRequests()
        let loads = 0
        await runAgentLoop(user("new-prompt"), {
            systemPrompt: "System", tools: [], getContext: () => { loads++; return owner.getContext() },
            getRecentConversation: () => manager.loadRecentConversation(SESSION_ID),
        }, loopOptions(model, (event) => acceptMessage(manager, owner, event)))

        expect(requests).toHaveLength(1)
        expect(requests[0]?.messages.map((message) => message.id)).toEqual([
            ...Array.from({ length: 1_050 }, (_, index) => `history-${index}`), "new-prompt",
        ])
        expect(requests[0]?.contextSummary).toBe(checkpointKind === "usable" ? SUMMARY : undefined)
        expect(loads).toBe(1)
        expect(manager.loadHistoryPage(SESSION_ID, "main").messages).toHaveLength(HISTORY_MESSAGE_TARGET)
    }))
}

for (const requiresConversationContext of [false, true]) {
    test(`tool batches read conversation only when required (${requiresConversationContext})`, async () => withHistory(async (manager) => {
        const owner = new AgentWorkingContext(manager.loadRequiredContext(SESSION_ID))
        const observed: IAgentToolContext[] = []
        const tools = [false, requiresConversationContext].map((required, index) => defineAgentTool({
            name: `probe-${index}`, description: "Inspect context", inputSchema: { type: "object" },
            requiresConversationContext: required,
            async execute(_input, context) { observed.push(context); return "ok" },
        }))
        const { model } = modelWithRequests((turn) => turn === 0 ? [
            { type: "tool-call", toolCallId: "first", toolName: "probe-0", input: {} },
            { type: "tool-call", toolCallId: "second", toolName: "probe-1", input: {} },
            { type: "finish", reason: "tool-calls" },
        ] : [{ type: "finish", reason: "stop" }])
        const read = spyOn(manager, "loadRecentConversation")
        try {
            await runAgentLoop(user("prompt"), {
                systemPrompt: "System", tools, getContext: owner.getContext,
                getRecentConversation: () => manager.loadRecentConversation(SESSION_ID),
            }, loopOptions(model, (event) => acceptMessage(manager, owner, event)))
            expect(read).toHaveBeenCalledTimes(requiresConversationContext ? 1 : 0)
            expect(observed).toHaveLength(2)
            expect(observed[0]?.messages).toBeUndefined()
            if (requiresConversationContext) {
                expect(observed[1]?.messages?.map((message) => message.id)).toEqual(["prompt"])
            } else {
                expect(observed[1]?.messages).toBeUndefined()
            }
        } finally { read.mockRestore() }
    }))
}

test("loop request excludes a sibling branch while preserving the complete inherited prefix", async () => withHistory(async (manager) => {
    manager.appendMessage(user("ancestor-user"))
    manager.appendMessage(assistant("ancestor-answer"))
    manager.createBranch(SESSION_ID, "sibling")
    manager.appendMessage(user("sibling-private"))
    manager.returnToParentBranch(SESSION_ID)
    manager.createBranch(SESSION_ID, "selected")
    manager.appendMessage(user("selected-user"))
    const owner = new AgentWorkingContext(manager.loadRequiredContext(SESSION_ID))
    const { model, requests } = modelWithRequests()
    await runAgentLoop(user("new-prompt"), { systemPrompt: "System", tools: [], getContext: owner.getContext,
        getRecentConversation: () => manager.loadRecentConversation(SESSION_ID) },
        loopOptions(model, (event) => acceptMessage(manager, owner, event)))
    expect(requests[0]?.messages.map((message) => message.id)).toEqual([
        "ancestor-user", "ancestor-answer", "selected-user", "new-prompt",
    ])
}))

test("loop waits for prompt acceptance and does not append an identical durable retry twice", async () => withHistory(async (manager) => {
    const prompt = user("retry-prompt")
    manager.appendMessage(prompt)
    const owner = new AgentWorkingContext(manager.loadRequiredContext(SESSION_ID))
    const { model, requests } = modelWithRequests()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let reads = 0
    const running = runAgentLoop(prompt, {
        systemPrompt: "System", tools: [], getContext: () => { reads++; return owner.getContext() },
        getRecentConversation: () => manager.loadRecentConversation(SESSION_ID),
    }, loopOptions(model, async (event) => {
        if (event.type === "message_end" && event.message.role === "user") {
            entered.resolve()
            await release.promise
        }
        acceptMessage(manager, owner, event)
    }))
    await entered.promise
    expect(reads).toBe(0)
    expect(requests).toHaveLength(0)
    release.resolve()
    await running
    expect(requests[0]?.messages.map((message) => message.id)).toEqual([prompt.id])
    expect(owner.getContext().messages).toHaveLength(2)
}))

test("loop rereads a replaced summary and the current committed suffix before tool continuation", async () => withHistory(async (manager) => {
    const owner = new AgentWorkingContext(manager.loadRequiredContext(SESSION_ID))
    const { model, requests } = modelWithRequests((turn) => turn === 0 ? [
        { type: "tool-call", toolCallId: "call", toolName: TOOL_NAME, input: {} },
        { type: "finish", reason: "tool-calls" },
    ] : [{ type: "finish", reason: "stop" }])
    const tool = defineAgentTool({ name: TOOL_NAME, description: "Inspect", inputSchema: { type: "object" }, async execute() {
        expect(manager.loadHistoryPage(SESSION_ID, "main").messages.at(-1)).toMatchObject({ role: "assistant" })
        return "full result"
    } })
    let captured = owner.getContext()
    await runAgentLoop(user("prompt"), { systemPrompt: "System", tools: [tool], getContext: owner.getContext,
        getRecentConversation: () => manager.loadRecentConversation(SESSION_ID) },
        loopOptions(model, (event) => {
            acceptMessage(manager, owner, event)
            if (event.type !== "turn_end" || event.index !== 0) return
            captured = owner.getContext()
            const anchor = event.toolResults[0]!
            saveCheckpoint(manager, anchor.id, 3)
            manager.appendMessage(user("committed-after-boundary-1"))
            manager.appendMessage(user("committed-after-boundary-2"))
            owner.replaceContext(manager.loadRequiredContext(SESSION_ID))
        }))
    expect(requests).toHaveLength(2)
    expect(requests[0]?.messages.map((message) => message.id)).toEqual(["prompt"])
    expect(requests[0]?.contextSummary).toBeUndefined()
    expect(requests[1]?.contextSummary).toBe(SUMMARY)
    expect(requests[1]?.messages.map((message) => message.id)).toEqual([
        "committed-after-boundary-1", "committed-after-boundary-2",
    ])
    expect(captured.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"])
    expect(captured.contextSummary).toBeUndefined()
}))

for (const failedRole of ["user", "assistant", "toolResult"] as const) {
    test(`a committed ${failedRole} acceptance failure blocks subsequent model/tool execution`, async () => withHistory(async (manager) => {
        const owner = new AgentWorkingContext(manager.loadRequiredContext(SESSION_ID))
        const { model, requests } = modelWithRequests(() => [
            { type: "tool-call", toolCallId: "call", toolName: TOOL_NAME, input: {} },
            { type: "tool-call", toolCallId: "must-not-run", toolName: TOOL_NAME, input: {} },
            { type: "finish", reason: "tool-calls" },
        ])
        let executions = 0
        const failure = new Error(`Cannot accept ${failedRole}`)
        const tool = defineAgentTool({ name: TOOL_NAME, description: "Inspect", inputSchema: { type: "object" }, async execute() {
            executions++
            return "committed result"
        } })
        const running = runAgentLoop(user("prompt"), { systemPrompt: "System", tools: [tool], getContext: owner.getContext,
            getRecentConversation: () => manager.loadRecentConversation(SESSION_ID) },
            loopOptions(model, (event) => {
                if (event.type !== "message_end") return
                manager.appendMessage(event.message)
                if (event.message.role === failedRole) throw failure
                owner.acceptCommittedMessage(event.message)
            }))
        await expect(running).rejects.toBe(failure)
        expect(requests).toHaveLength(failedRole === "user" ? 0 : 1)
        expect(executions).toBe(failedRole === "toolResult" ? 1 : 0)
        expect(manager.loadHistoryPage(SESSION_ID, "main").messages.at(-1)?.role).toBe(failedRole)
        expect(owner.getContext().messages).toHaveLength(failedRole === "user" ? 0 : failedRole === "assistant" ? 1 : 2)
    }))
}

test("a successful checkpoint save followed by a failed reload blocks continuation without replacing the old view", async () => withHistory(async (manager) => {
    const owner = new AgentWorkingContext(manager.loadRequiredContext(SESSION_ID))
    const { model, requests } = modelWithRequests(() => [
        { type: "tool-call", toolCallId: "call", toolName: TOOL_NAME, input: {} },
        { type: "finish", reason: "tool-calls" },
    ])
    const tool = defineAgentTool({ name: TOOL_NAME, description: "Inspect", inputSchema: { type: "object" }, async execute() {
        return "complete"
    } })
    const failure = new Error("Cannot reload committed context")
    let before = owner.getContext()
    await expect(runAgentLoop(user("prompt"), { systemPrompt: "System", tools: [tool], getContext: owner.getContext,
        getRecentConversation: () => manager.loadRecentConversation(SESSION_ID) },
        loopOptions(model, (event) => {
            acceptMessage(manager, owner, event)
            if (event.type !== "turn_end") return
            before = owner.getContext()
            saveCheckpoint(manager, event.toolResults[0]!.id, 3)
            const read = spyOn(manager, "loadRequiredContext").mockImplementation(() => { throw failure })
            try { owner.replaceContext(manager.loadRequiredContext(SESSION_ID)) }
            finally { read.mockRestore() }
        }))).rejects.toBe(failure)
    expect(requests).toHaveLength(1)
    expect(owner.getContext()).toBe(before)
    expect(manager.getCompactionCheckpoint(SESSION_ID)?.summary).toBe(SUMMARY)
    expect(manager.loadRequiredContext(SESSION_ID)).toMatchObject({ contextSummary: SUMMARY, messages: [] })
}))

test("replacing context without a summary removes the previous summary from the next request", async () => {
    const owner = new AgentWorkingContext({ messages: [], contextSummary: "old summary" })
    const { model, requests } = modelWithRequests((turn) => turn === 0 ? [
        { type: "tool-call", toolCallId: "call", toolName: TOOL_NAME, input: {} },
        { type: "finish", reason: "tool-calls" },
    ] : [{ type: "finish", reason: "stop" }])
    const tool = defineAgentTool({ name: TOOL_NAME, description: "Inspect", inputSchema: { type: "object" }, async execute() {
        return "complete"
    } })
    await runAgentLoop(user("prompt"), { systemPrompt: "System", tools: [tool], getContext: owner.getContext,
        getRecentConversation: () => owner.getContext().messages },
        loopOptions(model, (event) => {
            if (event.type === "message_end") owner.acceptCommittedMessage(event.message)
            if (event.type === "turn_end" && event.index === 0) owner.replaceContext({ messages: owner.getContext().messages })
        }))
    expect(requests[0]?.contextSummary).toBe("old summary")
    expect(requests[1]).not.toHaveProperty("contextSummary")
    expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"])
})

test("current-context reads preserve images, selected paths, system/tools, captured configuration and the run signal", async () => withHistory(async (manager) => {
    const reference: IUserPathReference = { type: "path", kind: "file", path: "/workspace/file.ts", source: { value: "file", start: 0, end: 4 } }
    manager.appendMessage({ ...user("previous"), content: "file", references: [reference] })
    manager.appendMessage(assistant("previous-answer"))
    saveCheckpoint(manager, "previous-answer", 2)
    const owner = new AgentWorkingContext(manager.loadRequiredContext(SESSION_ID))
    const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII="
    const prompt: IUserMessage = { ...user("image-prompt"), content: "image file", references: [{ ...reference, path: "/workspace/current.ts", source: { value: "file", start: 6, end: 10 } }],
        attachments: [{ type: "image", mimeType: "image/png", data: imageData, filename: "image.png", source: { value: "image", start: 0, end: 5 } }] }
    let received: IAgentToolContext | undefined
    const tool = defineAgentTool({ name: TOOL_NAME, description: "Inspect", inputSchema: { type: "object" },
        requiresConversationContext: true, acceptsSelectedPathReferences: true, async execute(_input, context) {
            received = context
            return { content: "full result", summary: "tool summary", diff: "+change", outcome: "completed" }
        } })
    const { model, requests } = modelWithRequests((turn) => turn === 0 ? [
        { type: "tool-call", toolCallId: "call", toolName: TOOL_NAME, input: {} },
        { type: "finish", reason: "tool-calls" },
    ] : [{ type: "finish", reason: "stop" }])
    const options = loopOptions(model, (event) => acceptMessage(manager, owner, event))
    const modelProfile = { providerId: "captured-provider", modelId: "captured-model" }
    await runAgentLoop(prompt, { systemPrompt: "Captured system", tools: [tool], getContext: owner.getContext,
        getRecentConversation: () => manager.loadRecentConversation(SESSION_ID),
        selectedPathReferences: manager.loadSelectedPaths(SESSION_ID) },
    { ...options, modelProfile, providerAccountId: "captured-account" })
    expect(requests).toHaveLength(2)
    for (const request of requests) {
        expect(request.systemPrompt).toBe("Captured system")
        expect(request.contextSummary).toBe(SUMMARY)
        expect(request.reasoningEffort).toBe("high")
        expect(request.signal).toBe(options.signal)
        expect(request.tools).toEqual([{ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }])
        expect(request.messages.filter((message) => message.id === prompt.id)).toEqual([prompt])
    }
    expect(requests[1]?.messages.at(-1)).toMatchObject({ role: "toolResult", content: "full result", summary: "tool summary", diff: "+change" })
    expect(received?.modelProfile).toEqual(modelProfile)
    expect(received?.providerAccountId).toBe("captured-account")
    expect(received?.signal).toBe(options.signal)
    expect(received?.selectedPathReferences).toEqual([reference, ...prompt.references!])
    expect(received?.messages?.map((message) => message.id)).toEqual(["previous", "previous-answer", "image-prompt"])
}))

test("a required-context read failure propagates without entering the model", async () => {
    const failure = new Error("Context unavailable")
    const { model, requests } = modelWithRequests()
    const events: TAgentEvent[] = []
    await expect(runAgentLoop(user("prompt"), {
        systemPrompt: "System", tools: [], getContext: () => { throw failure }, getRecentConversation: () => [],
    }, loopOptions(model, (event) => { events.push(event) }))).rejects.toBe(failure)
    expect(requests).toHaveLength(0)
    expect(events.filter((event) => event.type === "message_start")).toHaveLength(1)
})

test("a rejected queued acceptance restores the message and prevents another request", async () => withHistory(async (manager) => {
    const owner = new AgentWorkingContext(manager.loadRequiredContext(SESSION_ID))
    const { model, requests } = modelWithRequests()
    const steering: IUserMessage[] = [{ ...user("steering"), source: "steer" }]
    const queue: IAgentInputQueue = {
        hasSteering: () => steering.length > 0, takeSteering: () => steering.shift(),
        hasFollowUp: () => false, takeFollowUp: () => undefined,
        restore: (message) => { steering.unshift(message) }, close: () => {},
    }
    const failure = new Error("Steering acceptance failed")
    await expect(runAgentLoop(user("prompt"), { systemPrompt: "System", tools: [], getContext: owner.getContext,
        getRecentConversation: () => manager.loadRecentConversation(SESSION_ID) }, {
        ...loopOptions(model, (event) => {
            if (event.type === "message_end" && event.message.id === "steering") {
                manager.appendMessage(event.message)
                throw failure
            }
            acceptMessage(manager, owner, event)
        }), inputQueue: queue,
    })).rejects.toBe(failure)
    expect(steering.map((message) => message.id)).toEqual(["steering"])
    expect(requests).toHaveLength(1)
    expect(manager.loadHistoryPage(SESSION_ID, "main").messages.at(-1)?.id).toBe("steering")
}))
