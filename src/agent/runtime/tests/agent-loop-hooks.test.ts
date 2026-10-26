import { expect, test } from "bun:test"
import { Type } from "typebox"

import type {
  IAgentHooks,
  IAgentModel,
  IAgentModelRequest,
  IHookDecision,
  TAgentEvent,
  TAgentMessage,
  TAgentModelEvent,
} from "@/agent"
import { defineAgentTool, withHookContextInContent } from "@/agent"
import { runAgentLoopWithContext as runAgentLoop } from "../../../../tests/fixtures/agent-loop"

class ScriptedModel implements IAgentModel {
  readonly requests: IAgentModelRequest[] = []

  constructor(private readonly script: (iteration: number) => readonly TAgentModelEvent[]) {}

  async *stream(request: IAgentModelRequest): AsyncIterable<TAgentModelEvent> {
    const iteration = this.requests.length
    this.requests.push({ ...request, messages: structuredClone(request.messages) })
    for (const event of this.script(iteration)) yield event
  }
}

const answer: readonly TAgentModelEvent[] = [
  { type: "text-start", id: "answer" },
  { type: "text-delta", id: "answer", delta: "Done" },
  { type: "text-end", id: "answer" },
  { type: "finish", reason: "stop" },
]

function writeCall(path: string): readonly TAgentModelEvent[] {
  return [
    { type: "tool-call", toolCallId: "call-write", toolName: "write", input: { path } },
    { type: "finish", reason: "tool-calls" },
  ]
}

const writeTool = defineAgentTool({
  name: "write",
  description: "Write a file",
  inputSchema: Type.Object({ path: Type.String() }),
  async execute(input) {
    return `wrote ${input.path}`
  },
})

function hooks(overrides: Partial<{
  beforePrompt: IHookDecision
  beforeTool: IHookDecision
  afterTool: string
}>): IAgentHooks & { readonly calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async beforePrompt(message) {
      calls.push(`prompt:${message.content}`)
      return overrides.beforePrompt ?? {}
    },
    async beforeTool(call) {
      calls.push(`before:${call.toolName}`)
      return overrides.beforeTool ?? {}
    },
    async afterTool(call, result) {
      calls.push(`after:${call.toolName}:${result.content}`)
      return overrides.afterTool
    },
    afterMessage() {},
    afterRun() {},
    async endSession() {},
  }
}

async function run(model: ScriptedModel, agentHooks: IAgentHooks) {
  const committed: TAgentMessage[] = []
  const result = await runAgentLoop(
    {
      id: "user-message",
      sessionId: "session-1",
      runId: "run-1",
      role: "user",
      source: "prompt",
      content: "Change it",
      createdAt: 1,
    },
    { systemPrompt: "System", messages: [], tools: [writeTool] },
    {
      sessionId: "session-1",
      runId: "run-1",
      model,
      reasoningEffort: "medium",
      signal: new AbortController().signal,
      emit: (event: TAgentEvent) => {
        if (event.type === "message_end") committed.push(structuredClone(event.message))
      },
      hooks: agentHooks,
    },
  )
  return { result, committed }
}

test("prompt hook context is stored apart from the user's text", async () => {
  const model = new ScriptedModel(() => answer)
  const { committed } = await run(model, hooks({ beforePrompt: { context: "Memory: prefers Polish" } }))

  expect(committed[0]).toMatchObject({ role: "user", content: "Change it", hookContext: "Memory: prefers Polish" })
})

test("the model receives hook context after the content as a system reminder", () => {
  const message = {
    id: "t", sessionId: "s", runId: "r", role: "toolResult" as const, assistantMessageId: "a",
    toolCallId: "c", toolName: "write", content: "wrote", isError: false, hookContext: "ISA synced", createdAt: 1,
  }

  const sent = withHookContextInContent(message)

  expect(sent).toMatchObject({ content: "wrote\n\n<system-reminder>\nISA synced\n</system-reminder>" })
  expect(sent).not.toHaveProperty("hookContext")
  const { hookContext: _, ...plain } = message
  expect(withHookContextInContent(plain)).toBe(plain)
})

test("a blocked prompt fails the run before anything reaches history or the model", async () => {
  const model = new ScriptedModel(() => answer)
  const committed: TAgentMessage[] = []

  await expect(runAgentLoop(
    { id: "u", sessionId: "s", runId: "r", role: "user", source: "prompt", content: "secret", createdAt: 1 },
    { systemPrompt: "System", messages: [], tools: [] },
    {
      sessionId: "s",
      runId: "r",
      model,
      reasoningEffort: "medium",
      signal: new AbortController().signal,
      emit: (event) => { if (event.type === "message_end") committed.push(event.message) },
      hooks: hooks({ beforePrompt: { blockReason: "contains a secret" } }),
    },
  )).rejects.toThrow("Prompt blocked by hook: contains a secret")
  expect(committed).toEqual([])
  expect(model.requests).toEqual([])
})

test("a blocked tool call returns a model-visible error and never executes", async () => {
  const model = new ScriptedModel((iteration) => iteration === 0 ? writeCall("prod.env") : answer)
  const agentHooks = hooks({ beforeTool: { blockReason: "protected file" } })
  const { committed } = await run(model, agentHooks)

  expect(committed.find((message) => message.role === "toolResult")).toMatchObject({
    content: "Tool call blocked by hook: protected file",
    isError: true,
  })
  expect(agentHooks.calls).toEqual(["prompt:Change it", "before:write"])
})

test("context from before and after a tool call is attached to its result", async () => {
  const model = new ScriptedModel((iteration) => iteration === 0 ? writeCall("notes.md") : answer)
  const agentHooks = hooks({ beforeTool: { context: "ISA is open" }, afterTool: "ISA synced" })
  const { committed } = await run(model, agentHooks)

  expect(committed.find((message) => message.role === "toolResult")).toMatchObject({
    content: "wrote notes.md",
    hookContext: "ISA is open\n\nISA synced",
  })
  expect(agentHooks.calls).toEqual(["prompt:Change it", "before:write", "after:write:wrote notes.md"])
})
