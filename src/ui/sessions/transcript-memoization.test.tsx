import { expect, spyOn, test } from "bun:test"
import { MarkdownRenderable, TextRenderable, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { act, useState, type ComponentProps, type ReactNode } from "react"
import * as diffLibrary from "diff"
import { Type } from "typebox"

import { defineAgentTool, type IAgentModel, type IAssistantMessage, type IToolResultMessage, type TAgentMessage } from "@/agent"
import type { IBuliApplication } from "@/app/contracts"
import { AgentSession, SQLiteSessionManager } from "@/sessions"
import { BuliRuntimeProvider } from "@/ui/context/application-context"
import { SessionTranscript } from "@/ui/sessions/SessionTranscript"
import * as cards from "@/ui/components/MessageCard"
import { AssistantCard } from "@/ui/sessions/AssistantCard"
import * as diffs from "@/ui/sessions/FileChangeDiff"
import * as markdown from "@/ui/sessions/MarkdownBody"
import * as reasoning from "@/ui/sessions/ReasoningBlock"
import { ToolCallDisplay, ToolCallView } from "@/ui/sessions/ToolCallDisplay"
import { Transcript, type ITranscriptProps } from "@/ui/sessions/Transcript"

const patch = "--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-before\n+after\n"
const base = { sessionId: "memoization", runId: "run", createdAt: 1 }

// Instrument the inner render function without replacing React's memo boundary.
// Counts therefore measure actual executions, not element creation or comparisons.
function memoRender<Props>(component: unknown): { type: (props: Props) => ReactNode } {
    return component as { type: (props: Props) => ReactNode }
}

function descendants(root: Renderable): Renderable[] {
    return root.getChildren().flatMap(child => [child, ...descendants(child)])
}

function response(id: string, text: string): IAssistantMessage {
    return {
        ...base, id, role: "assistant", stopReason: "toolUse",
        content: [
            { type: "reasoning", text: `Reasoning ${id}` },
            { type: "toolCall", toolCallId: `call-${id}`, toolName: "read", input: { path: `${id}.ts` } },
            { type: "text", text },
        ],
    }
}

function result(id: string): IToolResultMessage {
    return {
        ...base, id: `result-${id}`, role: "toolResult", assistantMessageId: id,
        toolCallId: `call-${id}`, toolName: "read", content: "", isError: false, diff: patch,
    }
}

function signal() {
    let resolve!: () => void
    const promise = new Promise<void>(done => { resolve = done })
    return { promise, resolve }
}

function history(groups: number): readonly TAgentMessage[] {
    return Array.from({ length: groups }, (_, index): TAgentMessage[] => [
        { ...base, id: `user-${index}`, role: "user", source: "prompt", content: `Prompt ${index}` },
        response(`old-${index}`, `Answer ${index}`),
        result(`old-${index}`),
    ]).flat()
}

test("skips historical cards and unchanged live views on text and compaction updates", async () => {
    const fragments = spyOn(memoRender<ComponentProps<typeof AssistantCard>>(AssistantCard), "type")
    const tools = spyOn(memoRender<ComponentProps<typeof ToolCallView>>(ToolCallView), "type")
    const users = spyOn(cards, "MessageCard")
    const changes = spyOn(diffs, "FileChangeDiff")
    const parse = spyOn(diffLibrary, "parsePatch")
    const bodies = spyOn(markdown, "MarkdownBody")
    const thoughts = spyOn(reasoning, "ReasoningBlock")
    const spies = [fragments, tools, users, changes, parse, bodies, thoughts]
    const messages = history(20)
    const pendingToolCallIds: readonly string[] = []
    let update!: (props: ITranscriptProps) => void
    function Harness() {
        const [props, setProps] = useState<ITranscriptProps>({
            messages, streamingMessage: response("live", "Answer"), pendingToolCallIds,
        })
        update = setProps
        return <box id="transcript" flexDirection="column"><Transcript {...props} /></box>
    }
    let setup: Awaited<ReturnType<typeof testRender>> | undefined
    try {
        setup = await testRender(<Harness />, { width: 80, height: 24 })
        await act(async () => { await setup!.renderOnce() })
        expect(users).toHaveBeenCalledTimes(20)
        expect(changes).toHaveBeenCalledTimes(20)
        expect(parse).toHaveBeenCalledTimes(20)
        expect(tools).toHaveBeenCalledTimes(21)
        const root = setup.renderer.root
        const oldMarkdown = descendants(root).filter(node => node instanceof MarkdownRenderable)
        const liveLine = descendants(root).find(node => node instanceof TextRenderable && node.plainText.includes("Read [live.ts]"))
        expect(liveLine).toBeDefined()
        // Each fragment stays a direct native child, including across the history/live boundary.
        expect(root.findDescendantById("transcript")!.getChildren()).toHaveLength(83)

        for (let delta = 1; delta <= 5; delta++) {
            spies.forEach(spy => spy.mockClear())
            await act(async () => { update({
                messages, streamingMessage: response("live", `Answer ${delta}`), pendingToolCallIds,
            }) })
            // The cloned live tool prepares its presentation; only changed text renders a view.
            expect(fragments.mock.calls.map(([props]) => props.kind)).toEqual(["tool", "text"])
            expect(bodies).toHaveBeenCalledTimes(1)
            for (const spy of [tools, users, changes, parse, thoughts]) expect(spy).toHaveBeenCalledTimes(0)
        }

        spies.forEach(spy => spy.mockClear())
        await act(async () => { update({
            messages, streamingMessage: response("live", "Answer 5"), pendingToolCallIds,
        }) })
        expect(fragments.mock.calls.map(([props]) => props.kind)).toEqual(["tool"])
        for (const spy of [tools, users, changes, parse, bodies, thoughts]) expect(spy).toHaveBeenCalledTimes(0)

        for (const summary of ["Checkpoint", "Checkpoint summary"]) {
            spies.forEach(spy => spy.mockClear())
            await act(async () => { update({
                messages, streamingMessage: response("live", "Answer 5"), pendingToolCallIds,
                compactionProgress: { id: "checkpoint", throughMessageId: "result-old-19", summary },
            }) })
            for (const spy of [tools, users, changes, parse, bodies, thoughts]) expect(spy).toHaveBeenCalledTimes(0)
        }
        await act(async () => { await setup!.renderOnce() })
        const nodes = descendants(root)
        expect(oldMarkdown.every(node => nodes.includes(node))).toBe(true)
        expect(nodes).toContain(liveLine!)
        const children = root.findDescendantById("transcript")!.getChildren()
        expect(descendants(children[80]!).some(node => node instanceof TextRenderable && node.plainText === "Checkpoint summary")).toBe(true)

        // A freshly decoded page can rebuild elements without remounting the live fragment.
        await act(async () => { update({
            messages: [...structuredClone(messages), response("live", "Answer 5")],
            activeRunId: "run", pendingToolCallIds,
        }) })
        expect(descendants(root)).toContain(liveLine!)
        expect(oldMarkdown.every(node => descendants(root).includes(node))).toBe(true)
    } finally {
        const renderer = setup?.renderer
        if (renderer) act(() => renderer.destroy())
        spies.forEach(spy => spy.mockRestore())
    }
})

test("memoized tool views update visible values even when call and result IDs stay the same", async () => {
    const view = spyOn(memoRender<ComponentProps<typeof ToolCallView>>(ToolCallView), "type")
    const parse = spyOn(diffLibrary, "parsePatch")
    type Props = ComponentProps<typeof ToolCallDisplay>
    const call = { type: "toolCall" as const, toolCallId: "call-live", toolName: "read", input: { path: "live.ts", offset: 1 } }
    let update!: (props: Props) => void
    function Harness() {
        const [props, setProps] = useState<Props>({ call, phase: "pending" })
        update = setProps
        return <ToolCallDisplay {...props} />
    }
    let setup: Awaited<ReturnType<typeof testRender>> | undefined
    try {
        setup = await testRender(<Harness />, { width: 80, height: 16 })
        expect(view).toHaveBeenCalledTimes(1)
        await act(async () => { update({ call: structuredClone(call), phase: "running" }) })
        expect(view).toHaveBeenCalledTimes(1)
        const changedCall = { ...call, input: { path: "changed.ts", offset: 2 } }
        await act(async () => { update({ call: changedCall, phase: "running" }) })
        expect(view).toHaveBeenCalledTimes(2)
        expect(view.mock.calls.at(-1)![0]).toMatchObject({ target: "changed.ts", detail: "offset=2" })

        const completed = { ...result("live"), summary: "Done" }
        await act(async () => { update({ call: changedCall, result: completed }) })
        expect(view).toHaveBeenCalledTimes(3)
        expect(parse).toHaveBeenCalledTimes(1)
        await act(async () => { update({ call: structuredClone(changedCall), result: structuredClone(completed) }) })
        expect(view).toHaveBeenCalledTimes(3)
        const failed = { ...completed, isError: true, summary: "Failed", content: "Permission denied" }
        await act(async () => { update({ call: changedCall, result: failed }) })
        expect(view).toHaveBeenCalledTimes(4)
        expect(view.mock.calls.at(-1)![0]).toMatchObject({ detail: "offset=2 | Failed | Permission denied", accent: "#EF4444" })
        expect(parse).toHaveBeenCalledTimes(1)
        await act(async () => { update({ call: changedCall, result: { ...completed, outcome: "rejected" } }) })
        expect(view).toHaveBeenCalledTimes(5)
        expect(view.mock.calls.at(-1)![0].marker).toBeUndefined()
        const changedDiff = patch.replace("+after", "+updated")
        await act(async () => { update({ call: changedCall, result: { ...completed, diff: changedDiff } }) })
        expect(view).toHaveBeenCalledTimes(6)
        expect(view.mock.calls.at(-1)![0].diff).toBe(changedDiff)
        expect(parse).toHaveBeenCalledTimes(2)
        await act(async () => { await setup!.renderOnce() })
        expect(setup.captureCharFrame()).toContain("Read [changed.ts] offset=2 | Done")
        expect(setup.captureCharFrame()).toContain("updated")
    } finally {
        const renderer = setup?.renderer
        if (renderer) act(() => renderer.destroy())
        view.mockRestore()
        parse.mockRestore()
    }
})

test("real SQLite history-before-live publications retain native fragments and skip history on deltas", async () => {
    const manager = new SQLiteSessionManager({ databasePath: ":memory:" })
    manager.createSession({ id: base.sessionId, agentId: "buli", title: "Memoization", createdAt: 1, updatedAt: 1 })
    for (const message of history(2)) manager.appendMessage(message)
    const streaming = signal()
    const nextDelta = signal()
    const deltaPublished = signal()
    const commit = signal()
    const executing = signal()
    const toolFinished = signal()
    let turns = 0
    const model: IAgentModel = { async *stream() {
        if (++turns > 1) {
            yield { type: "text-start", id: "final" }
            yield { type: "text-delta", id: "final", delta: "Finished" }
            yield { type: "finish", reason: "stop" }
            return
        }
        yield { type: "tool-call", toolCallId: "call-live", toolName: "read", input: { path: "live.ts" } }
        yield { type: "text-start", id: "text" }
        yield { type: "text-delta", id: "text", delta: "Live answer" }
        streaming.resolve()
        await nextDelta.promise
        yield { type: "text-delta", id: "text", delta: " growing" }
        deltaPublished.resolve()
        await commit.promise
        yield { type: "finish", reason: "tool_calls" }
    } }
    const session = new AgentSession({
        agentId: "buli", sessionId: base.sessionId, manager, systemPrompt: "Test",
        resolveRunConfiguration: () => ({ model, reasoningEffort: "medium" }),
        tools: [defineAgentTool({
            name: "read", description: "Isolated in-memory test tool", access: "read-only", inputSchema: Type.Object({ path: Type.String() }),
            execute: async () => { executing.resolve(); await toolFinished.promise; return "Done" },
        })],
    })
    // SessionTranscript only requests openSession; all data/subscriptions are real.
    const runtime = { openSession: () => session } as unknown as IBuliApplication
    const users = spyOn(cards, "MessageCard")
    const changes = spyOn(diffs, "FileChangeDiff")
    const parse = spyOn(diffLibrary, "parsePatch")
    const loads = spyOn(session, "loadHistoryPage")
    const fragments = spyOn(memoRender<ComponentProps<typeof AssistantCard>>(AssistantCard), "type")
    const notifications: string[] = []
    const unsubscribeHistory = session.subscribeHistory(() => { notifications.push("history") })
    const unsubscribeLive = session.subscribe(() => { notifications.push("live") })
    let setup: Awaited<ReturnType<typeof testRender>> | undefined
    let finished: Promise<void> | undefined
    try {
        await act(async () => {
            setup = await testRender(<BuliRuntimeProvider runtime={runtime}>
                <SessionTranscript sessionId={base.sessionId} />
            </BuliRuntimeProvider>, { width: 80, height: 24 })
        })
        await act(async () => {
            finished = session.prompt("Continue").runFinished
            await streaming.promise
        })
        await act(async () => { await setup!.renderOnce() })
        const root = setup!.renderer.root
        const liveLine = descendants(root).find(node => node instanceof TextRenderable && node.plainText.includes("Read [live.ts]"))
        const liveText = descendants(root).find(node => node instanceof MarkdownRenderable && node.content === "Live answer")
        expect(liveLine).toBeDefined()
        expect(liveText).toBeDefined()
        for (const spy of [users, changes, parse, loads, fragments]) spy.mockClear()
        await act(async () => { nextDelta.resolve(); await deltaPublished.promise })
        for (const spy of [users, changes, parse, loads]) expect(spy).toHaveBeenCalledTimes(0)
        expect(fragments.mock.calls.map(([props]) => props.kind)).toEqual(["text"])
        expect((liveText as MarkdownRenderable).content).toBe("Live answer growing")

        notifications.length = 0
        await act(async () => { commit.resolve(); await executing.promise })
        expect(notifications[0]).toBe("history")
        expect(notifications).toContain("live")
        expect(loads).toHaveBeenCalledTimes(1)
        expect(descendants(root)).toContain(liveLine!)
        expect(descendants(root)).toContain(liveText!)
        await act(async () => { toolFinished.resolve(); await finished })
        expect(descendants(root)).toContain(liveLine!)
        expect(descendants(root)).toContain(liveText!)
    } finally {
        nextDelta.resolve()
        commit.resolve()
        toolFinished.resolve()
        const renderer = setup?.renderer
        if (renderer) act(() => renderer.destroy())
        unsubscribeHistory()
        unsubscribeLive()
        try {
            await finished
            await session.dispose()
        } finally {
            for (const spy of [users, changes, parse, loads, fragments]) spy.mockRestore()
            manager.dispose()
        }
    }
})
