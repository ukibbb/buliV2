import { expect, test } from "bun:test"

import type {
  TAgentMessage,
  IAssistantMessage,
  IFileChangeProposalRecord,
  IToolResultMessage,
  IUserMessage,
} from "@/agent"
import { InMemorySessionManager, type ISessionInfo } from "@/sessions"

test("stores defensive metadata copies and rejects duplicate session IDs", () => {
  const manager = new InMemorySessionManager()
  const original = sessionInfo()

  manager.createSession(original)
  ;(original as { title: string }).title = "Mutated input"

  const returned = manager.getSessionInfo("session-1")
  if (!returned) throw new Error("Expected session metadata")
  ;(returned as { title: string }).title = "Mutated returned copy"

  const listed = manager.listSessions()
  ;(listed[0] as { title: string }).title = "Mutated listed copy"
  ;(listed as ISessionInfo[]).push(sessionInfo("injected"))

  expect(manager.getSessionInfo("session-1")).toEqual(sessionInfo())
  expect(manager.listSessions()).toEqual([sessionInfo()])
  expect(() => manager.createSession(sessionInfo())).toThrow(
    "Session already exists: session-1",
  )
})

test("rejects metadata that cannot be reopened", () => {
  const manager = new InMemorySessionManager()

  expect(() => manager.createSession(sessionInfo("", {}))).toThrow(
    "Invalid session metadata",
  )
  expect(() => manager.createSession(sessionInfo("session-1", {
    title: "",
  }))).toThrow("Invalid session metadata")
  expect(() => manager.createSession(sessionInfo("session-1", {
    createdAt: 2,
    updatedAt: 1,
  }))).toThrow("Invalid session metadata")
})

test("stores message copies, replaces duplicate IDs, and advances updatedAt monotonically", () => {
  const manager = new InMemorySessionManager()
  manager.createSession(sessionInfo("session-1", { createdAt: 5, updatedAt: 5 }))
  const original = userMessage("First", "session-1", "message-1", 20)

  manager.appendMessage(original)
  ;(original as { content: string }).content = "Mutated outside manager"

  expect(manager.getMessages("session-1")[0]).toMatchObject({
    content: "First",
  })
  expect(manager.getSessionInfo("session-1")?.updatedAt).toBe(20)

  manager.appendMessage(userMessage(
    "Replacement",
    "session-1",
    "message-1",
    10,
  ))
  const returned = manager.getMessages("session-1")
  const returnedMessage = returned[0]
  if (returnedMessage?.role === "user") {
    ;(returnedMessage as { content: string }).content = "Mutated returned copy"
  }

  expect(manager.getMessages("session-1")).toEqual([
    userMessage("Replacement", "session-1", "message-1", 10),
  ])
  expect(manager.getSessionInfo("session-1")?.updatedAt).toBe(20)
})

test("keeps structured tool input and tool results independent", () => {
  const manager = new InMemorySessionManager()
  manager.createSession(sessionInfo())
  manager.appendMessage(completedAssistant([{
    type: "toolCall",
    toolCallId: "call-1",
    toolName: "grep",
    input: { pattern: "Agent" },
  }]))
  manager.appendMessage(toolResultMessage("src/agent/agent.ts"))

  const returned = manager.getMessages("session-1")
  const assistant = returned[0]
  if (assistant?.role !== "assistant") {
    throw new Error("Expected assistant message")
  }
  const toolCall = assistant.content[0]
  if (toolCall?.type !== "toolCall") {
    throw new Error("Expected tool call")
  }
  const toolResult = returned[1]
  if (toolResult?.role !== "toolResult") {
    throw new Error("Expected tool result")
  }
  ;(toolCall.input as { pattern: string }).pattern = "mutated"
  ;(toolResult as { content: string }).content = "mutated"

  expect(manager.getMessages("session-1")).toEqual([
    completedAssistant([{
      type: "toolCall",
      toolCallId: "call-1",
      toolName: "grep",
      input: { pattern: "Agent" },
    }]),
    toolResultMessage("src/agent/agent.ts"),
  ])
})

test("requires session metadata and rejects invalid durable messages", () => {
  const manager = new InMemorySessionManager()

  expect(() => manager.appendMessage(userMessage("Question"))).toThrow(
    "Session does not exist: session-1",
  )

  manager.createSession(sessionInfo())
  expect(() => manager.appendMessage({
    ...completedAssistant([]),
    stopReason: "pending",
  })).toThrow("Cannot persist an incomplete assistant message")

  expect(() => manager.appendMessage({
    ...toolResultMessage("Result"),
    isError: "false",
  } as unknown as TAgentMessage)).toThrow("Invalid tool result message")
})

test("accepts legacy and structured tool results and validates optional fields", () => {
  const manager = new InMemorySessionManager()
  manager.createSession(sessionInfo())
  const legacy = toolResultMessage("Legacy result")
  manager.appendMessage(legacy)

  const outcomes = [
    "completed",
    "rejected",
    "manual",
    "failed",
    "committed-after-abort",
    "effects-unknown",
  ] as const
  const structured = outcomes.map((outcome, index): IToolResultMessage => ({
    ...toolResultMessage(`Structured ${outcome}`),
    id: `structured-${index}`,
    isError: outcome === "failed"
      || outcome === "committed-after-abort"
      || outcome === "effects-unknown",
    outcome,
    summary: `Summary ${outcome}`,
  }))
  structured.forEach(manager.appendMessage)

  expect(manager.getMessages("session-1")).toEqual([legacy, ...structured])
  expect(() => manager.appendMessage({
    ...toolResultMessage("Invalid outcome"),
    id: "invalid-outcome",
    outcome: "unknown",
  } as unknown as TAgentMessage)).toThrow("Invalid tool result message")
  expect(() => manager.appendMessage({
    ...toolResultMessage("Invalid summary"),
    id: "invalid-summary",
    summary: 42,
  } as unknown as TAgentMessage)).toThrow("Invalid tool result message")
  expect(() => manager.appendMessage({
    ...toolResultMessage("Contradictory failed result"),
    id: "contradictory-failed",
    outcome: "failed",
    isError: false,
  } as unknown as TAgentMessage)).toThrow("Invalid tool result message")
  expect(() => manager.appendMessage({
    ...toolResultMessage("Contradictory completed result"),
    id: "contradictory-completed",
    outcome: "completed",
    isError: true,
  } as unknown as TAgentMessage)).toThrow("Invalid tool result message")
})

test("rejects sparse, cyclic, and non-JSON values nested in tool input", () => {
  const manager = new InMemorySessionManager()
  manager.createSession(sessionInfo())
  const sparseArray = new Array<unknown>(2)
  sparseArray[1] = "value"
  const sparseArrayWithExtraProperty = new Array<unknown>(1)
  Object.assign(sparseArrayWithExtraProperty, { extra: "value" })
  const cyclicObject: Record<string, unknown> = {}
  cyclicObject.self = cyclicObject
  const invalidValues: readonly unknown[] = [
    sparseArray,
    sparseArrayWithExtraProperty,
    cyclicObject,
    undefined,
    Number.NaN,
    new Date("2026-01-01T00:00:00.000Z"),
    new Map([["key", "value"]]),
  ]

  for (const value of invalidValues) {
    expect(() => manager.appendMessage(completedAssistant([{
      type: "toolCall",
      toolCallId: "call-1",
      toolName: "read_file",
      input: { nested: { value } },
    }]))).toThrow("Invalid assistant tool call")
  }
  expect(manager.getMessages("session-1")).toEqual([])
})

test("rejects duplicate toolCallId entries in one assistant message", () => {
  const manager = new InMemorySessionManager()
  manager.createSession(sessionInfo())

  expect(() => manager.appendMessage(completedAssistant([
    {
      type: "toolCall",
      toolCallId: "call-1",
      toolName: "read_file",
      input: { path: "README.md" },
    },
    {
      type: "toolCall",
      toolCallId: "call-1",
      toolName: "grep",
      input: { pattern: "Agent" },
    },
  ]))).toThrow("Invalid assistant tool call")
  expect(manager.getMessages("session-1")).toEqual([])
})

test("stores the latest defensive file-change proposal state", () => {
  const manager = new InMemorySessionManager()
  manager.createSession(sessionInfo())
  const pending = fileChangeProposal()

  manager.restoreFileChangeProposal(pending)
  ;(pending as { diff: string }).diff = "mutated input"
  const returned = manager.getFileChangeProposals("session-1")
  ;(returned[0] as { diff: string }).diff = "mutated output"

  expect(manager.getFileChangeProposals("session-1")).toEqual([
    fileChangeProposal(),
  ])

  const applied = fileChangeProposal({
    status: "applied",
    resolvedAt: 3,
  })
  manager.restoreFileChangeProposal(applied)

  expect(manager.getFileChangeProposals("session-1")).toEqual([applied])
  expect(() => manager.restoreFileChangeProposal(fileChangeProposal({
    sessionId: "missing-session",
  }))).toThrow("Session does not exist: missing-session")
})

test("presentation revisions track successful metadata saves without reusing deleted session tokens", () => {
  const manager = new InMemorySessionManager()
  expect(manager.getPresentationRevision("session-1")).toBe(-1)
  manager.createSession(sessionInfo())
  const createdRevision = manager.getPresentationRevision("session-1")
  expect(createdRevision).toBeGreaterThan(-1)
  manager.createSession(sessionInfo("session-2"))
  const otherRevision = manager.getPresentationRevision("session-2")
  expect(otherRevision).toBe(createdRevision + 1)

  manager.appendMessage(userMessage("Question"))
  manager.appendMessage(userMessage("Replacement question"))
  manager.appendMessage(completedAssistant([{ type: "text", text: "Answer" }]))
  expect(manager.getPresentationRevision("session-1")).toBe(createdRevision)
  const checkpoint = {
    id: "checkpoint-1",
    sessionId: "session-1",
    createdAt: 3,
    reason: "manual" as const,
    compactedMessageCount: 2,
    throughMessageId: "assistant-1",
    summary: "Preserved context",
  }
  let revision = otherRevision
  // Successful saves invalidate even identical payloads; IDs are not cache keys.
  for (const save of [
    () => manager.restoreFileChangeProposal(fileChangeProposal()),
    () => manager.restoreFileChangeProposal(fileChangeProposal()),
    () => manager.saveCompactionCheckpoint(checkpoint),
    () => manager.saveCompactionCheckpoint(checkpoint),
  ]) {
    save()
    expect(manager.getPresentationRevision("session-1")).toBe(++revision)
    expect(manager.getPresentationRevision("session-2")).toBe(otherRevision)
  }

  for (const invalidSave of [
    () => manager.createSession(sessionInfo()),
    () => manager.restoreFileChangeProposal(fileChangeProposal({ diff: "" })),
    () => manager.restoreFileChangeProposal(fileChangeProposal({ sessionId: "missing" })),
    () => manager.saveCompactionCheckpoint({ ...checkpoint, summary: "" }),
    () => manager.saveCompactionCheckpoint({ ...checkpoint, throughMessageId: "missing" }),
    () => manager.saveCompactionCheckpoint({ ...checkpoint, sessionId: "missing" }),
  ]) {
    expect(invalidSave).toThrow()
    expect(manager.getPresentationRevision("session-1")).toBe(revision)
    expect(manager.getPresentationRevision("missing")).toBe(-1)
  }
  const returnedCheckpoint = manager.getCompactionCheckpoint("session-1")
  ;(returnedCheckpoint as { summary: string }).summary = "Mutated getter copy"
  expect(manager.getCompactionCheckpoint("session-1")).toEqual(checkpoint)
  expect(manager.getFileChangeProposals("session-1")).toEqual([fileChangeProposal()])
  expect(manager.getPresentationRevision("session-1")).toBe(revision)

  manager.deleteSession("session-1")
  expect(manager.getPresentationRevision("session-1")).toBe(-1)
  manager.createSession(sessionInfo())
  expect(manager.getPresentationRevision("session-1")).toBe(revision + 1)
  expect(manager.getPresentationRevision("session-2")).toBe(otherRevision)
  expect(manager.getFileChangeProposals("session-1")).toEqual([])
  expect(manager.getCompactionCheckpoint("session-1")).toBeUndefined()
})

test("delete removes selected metadata, messages, and proposals without affecting other sessions", () => {
  const manager = new InMemorySessionManager()
  manager.createSession(sessionInfo("session-1"))
  manager.createSession(sessionInfo("session-2", { title: "Second" }))
  const retained = userMessage("Second", "session-2", "user-2", 20)
  manager.appendMessage(userMessage("First", "session-1", "user-1", 10))
  manager.appendMessage(retained)
  manager.restoreFileChangeProposal(fileChangeProposal())
  manager.restoreFileChangeProposal(fileChangeProposal({
    id: "proposal-2",
    sessionId: "session-2",
  }))

  manager.deleteSession("session-1")

  expect(manager.getSessionInfo("session-1")).toBeUndefined()
  expect(manager.getMessages("session-1")).toEqual([])
  expect(manager.getSessionInfo("session-2")).toMatchObject({
    id: "session-2",
    title: "Second",
    updatedAt: 20,
  })
  expect(manager.getMessages("session-2")).toEqual([retained])
  expect(manager.getFileChangeProposals("session-1")).toEqual([])
  expect(manager.getFileChangeProposals("session-2")).toEqual([
    fileChangeProposal({ id: "proposal-2", sessionId: "session-2" }),
  ])
  expect(manager.listSessions().map((info) => info.id)).toEqual(["session-2"])
})

function fileChangeProposal(
  overrides: Partial<IFileChangeProposalRecord> = {},
): IFileChangeProposalRecord {
  return {
    id: "proposal-1",
    sessionId: "session-1",
    runId: "run-1",
    toolCallId: "edit-1",
    operation: "edit",
    path: "src/example.ts",
    diff: "-const value = 1\n+const value = 2\n",
    status: "pending",
    createdAt: 2,
    ...overrides,
  }
}

function sessionInfo(
  id = "session-1",
  overrides: Partial<Omit<ISessionInfo, "id">> = {},
): ISessionInfo {
  return {
    id,
    agentId: "test-agent",
    title: "First session",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function userMessage(
  content: string,
  sessionId = "session-1",
  id = "message-1",
  createdAt = 1,
): IUserMessage {
  return {
    id,
    sessionId,
    runId: "run-1",
    role: "user",
    source: "prompt",
    content,
    createdAt,
  }
}

function completedAssistant(
  content: IAssistantMessage["content"],
): IAssistantMessage {
  return {
    id: "assistant-1",
    sessionId: "session-1",
    runId: "run-1",
    role: "assistant",
    content,
    stopReason: "stop",
    createdAt: 1,
  }
}

function toolResultMessage(content: string): IToolResultMessage {
  return {
    id: "tool-result-1",
    sessionId: "session-1",
    runId: "run-1",
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "grep",
    content,
    isError: false,
    createdAt: 2,
  }
}
