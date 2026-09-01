import { expect, test } from "bun:test"
import {
  appendFile,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"

import type {
  TAgentMessage,
  IAgentModelRequest,
  IAssistantMessage,
  IFileChangeProposalRecord,
  IToolResultMessage,
  IUserMessage,
} from "@/agent"
import {
  AgentSession,
  defaultSessionFilePath,
  type ICompactionCheckpoint,
  type ISessionInfo,
  JsonlSessionManager,
} from "@/sessions"

test("stages cloned metadata and writes exact version 2 envelopes on first append", async () => {
  const directory = await mkdtemp(join(tmpdir(), "buli-jsonl-"))
  const filePath = join(directory, "nested", "sessions.jsonl")

  try {
    const manager = jsonlManager(filePath)
    const supplied = sessionInfo("session-1", {
      createdAt: 100,
      updatedAt: 100,
    })
    const expectedInfo = structuredClone(supplied)

    manager.createSession(supplied)
    ;(supplied as { title: string }).title = "Mutated input"
    expect(await Bun.file(filePath).exists()).toBe(false)

    const returned = manager.getSessionInfo("session-1")
    if (!returned) throw new Error("Expected session metadata")
    ;(returned as { title: string }).title = "Mutated returned metadata"
    const listed = manager.listSessions()
    ;(listed[0] as { title: string }).title = "Mutated listed metadata"
    ;(listed as ISessionInfo[]).pop()

    expect(manager.getSessionInfo("session-1")).toEqual(expectedInfo)
    expect(manager.listSessions()).toEqual([expectedInfo])
    expect(() => manager.createSession(expectedInfo)).toThrow(
      "Session already exists: session-1",
    )

    const user = userMessage("Question", { createdAt: 120 })
    manager.appendMessage(user)
    expect(await jsonlRecords(filePath)).toEqual([
      sessionRecord(expectedInfo),
      messageRecord(user),
    ])
    expect(manager.getSessionInfo("session-1")?.updatedAt).toBe(120)

    const assistant = assistantMessage("Complete answer", {
      completed: true,
      createdAt: 130,
    })
    manager.appendMessage(assistant)
    expect(await jsonlRecords(filePath)).toEqual([
      sessionRecord(expectedInfo),
      messageRecord(user),
      messageRecord(assistant),
    ])

    const contents = await readFile(filePath, "utf8")
    const restored = jsonlManager(filePath)
    expect(restored.getMessages("session-1")).toEqual([user, assistant])
    expect(restored.getSessionInfo("session-1")).toEqual({
      ...expectedInfo,
      updatedAt: 130,
    })
    expect(await readFile(filePath, "utf8")).toBe(contents)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("round-trips selected paths and direct image attachments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "buli-jsonl-resources-"))
  const filePath = join(directory, "sessions.jsonl")
  try {
    const manager = jsonlManager(filePath)
    manager.createSession(sessionInfo())
    const message: IUserMessage = {
      ...userMessage("Review @/tmp/file [Image 1]"),
      references: [{
        type: "path",
        kind: "file",
        path: "/tmp/file",
        source: { value: "@/tmp/file", start: 7, end: 17 },
      }],
      attachments: [{
        type: "image",
        mimeType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlL8AAAAASUVORK5CYII=",
        filename: "clipboard-1.png",
        source: { value: "[Image 1]", start: 18, end: 27 },
      }],
    }

    manager.appendMessage(message)
    expect(jsonlManager(filePath).getMessages("session-1")).toEqual([message])
    expect(() => manager.appendMessage({
      ...userMessage("Review @visible", { createdAt: 3 }),
      id: "detached-reference",
      references: [{
        type: "path",
        kind: "file",
        path: "/tmp/hidden",
        source: { value: "@visible", start: 99, end: 107 },
      }],
    })).toThrow("does not match message content")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("round-trips old and new tool result records without a version migration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "buli-jsonl-outcomes-"))
  const filePath = join(directory, "sessions.jsonl")

  try {
    const legacy = toolResultMessage("Legacy result")
    const structured: IToolResultMessage = {
      ...toolResultMessage("Applied result"),
      id: "structured-result",
      createdAt: 3,
      outcome: "manual",
      summary: "Run the copied command manually",
    }
    const unknownEffects: IToolResultMessage = {
      ...toolResultMessage("Execution may have changed files"),
      id: "unknown-effects-result",
      createdAt: 4,
      isError: true,
      outcome: "effects-unknown",
      summary: "Inspect current state before retrying",
    }
    await writeFile(filePath, serializeRecords([
      sessionRecord(sessionInfo()),
      messageRecord(legacy),
      messageRecord(structured),
      messageRecord(unknownEffects),
    ]), "utf8")

    const restored = jsonlManager(filePath)
    expect(restored.getMessages("session-1")).toEqual([
      legacy,
      structured,
      unknownEffects,
    ])
    expect(await jsonlRecords(filePath)).toEqual([
      sessionRecord(sessionInfo()),
      messageRecord(legacy),
      messageRecord(structured),
      messageRecord(unknownEffects),
    ])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("rejects appends without metadata and invalid appends without creating a file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "buli-jsonl-"))
  const filePath = join(directory, "sessions.jsonl")

  try {
    const manager = jsonlManager(filePath)

    expect(() => manager.appendMessage(userMessage("Question"))).toThrow(
      "Session does not exist: session-1",
    )
    expect(await Bun.file(filePath).exists()).toBe(false)

    manager.createSession(sessionInfo())
    expect(() => manager.appendMessage(assistantMessage("Partial"))).toThrow(
      "Cannot persist an incomplete assistant message",
    )
    expect(await Bun.file(filePath).exists()).toBe(false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("does not persist an AgentSession until its first non-blank prompt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "buli-jsonl-"))
  const filePath = join(directory, "sessions.jsonl")

  try {
    const manager = jsonlManager(filePath)
    const info = sessionInfo("new-session", {
      agentId: "test-agent",
      title: "New session",
    })
    manager.createSession(info)
    const session = new AgentSession({
      agentId: "test-agent",
      sessionId: "new-session",
      manager,
      systemPrompt: "System",
      tools: [],
      resolveRunConfiguration: () => ({
        model: {
          async *stream() {
            yield { type: "finish", reason: "stop" }
          },
        },
        reasoningEffort: "medium",
      }),
    })

    expect(await Bun.file(filePath).exists()).toBe(false)

    expect(() => session.prompt("   ")).toThrow("Prompt cannot be empty")
    expect(await Bun.file(filePath).exists()).toBe(false)

    const run = session.prompt("Hello")
    await run.accepted
    await run.settled
    const persisted = await jsonlRecords(filePath)
    expect(persisted).toHaveLength(3)
    expect(persisted[0]).toEqual(sessionRecord(info))
    expect(persisted[1]).toMatchObject({
      recordType: "message",
      version: 2,
      message: {
        role: "user",
        source: "prompt",
        content: "Hello",
        runId: run.runId,
      },
    })
    expect(persisted[2]).toMatchObject({
      recordType: "message",
      version: 2,
      message: { role: "assistant", runId: run.runId },
    })

    await session.dispose()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("eagerly loads interleaved records and applies repeated metadata last-write-wins", async () => {
  const directory = await mkdtemp(join(tmpdir(), "buli-jsonl-"))
  const filePath = join(directory, "sessions.jsonl")

  try {
    const firstMessage = userMessage("First", {
      id: "duplicate",
      createdAt: 8,
    })
    const replacement = userMessage("Replacement", {
      id: "duplicate",
      createdAt: 12,
    })
    const oldInfo = sessionInfo("session-1", {
      title: "Old title",
      createdAt: 1,
      updatedAt: 2,
    })
    const latestInfo = sessionInfo("session-1", {
      title: "Latest title",
      createdAt: 1,
      updatedAt: 4,
    })
    const metadataOnly = sessionInfo("session-2", {
      title: "Metadata only",
      createdAt: 6,
      updatedAt: 6,
    })
    const contents = serializeRecords([
      sessionRecord(oldInfo),
      messageRecord(firstMessage),
      messageRecord(replacement),
      sessionRecord(latestInfo),
      sessionRecord(metadataOnly),
    ])
    await writeFile(filePath, contents, "utf8")

    const restored = jsonlManager(filePath)

    expect(restored.getMessages("session-1")).toEqual([replacement])
    expect(restored.getSessionInfo("session-1")).toEqual({
      ...latestInfo,
      updatedAt: 12,
    })
    expect(restored.getSessionInfo("session-2")).toEqual(metadataOnly)
    expect(restored.listSessions().map((info) => info.id)).toEqual([
      "session-1",
      "session-2",
    ])
    expect(await readFile(filePath, "utf8")).toBe(contents)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("rejects message-only logs without session metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "buli-jsonl-"))
  const filePath = join(directory, "sessions.jsonl")

  try {
    await writeFile(
      filePath,
      serializeRecords([messageRecord(userMessage("Question"))]),
      "utf8",
    )

    expect(() => jsonlManager(filePath)).toThrow(
      "Invalid session JSONL record on line 1",
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("accepts only exact version 2 envelopes and reports invalid earlier lines", async () => {
  const directory = await mkdtemp(join(tmpdir(), "buli-jsonl-"))
  const filePath = join(directory, "sessions.jsonl")

  try {
    const validMetadata = JSON.stringify(sessionRecord(sessionInfo()))
    const validMessage = JSON.stringify(messageRecord(userMessage("Question")))
    const versionOneMetadata = JSON.stringify({
      ...sessionRecord(sessionInfo()),
      version: 1,
    })
    await writeFile(
      filePath,
      `${validMetadata}\n${versionOneMetadata}\n${validMessage}\n`,
      "utf8",
    )

    expect(() => jsonlManager(filePath)).toThrow(
      "Invalid session JSONL record on line 2",
    )

    await writeFile(
      filePath,
      `${validMetadata}\nnot-json\n${validMessage}\n`,
      "utf8",
    )
    expect(() => jsonlManager(filePath)).toThrow(
      "Invalid session JSONL record on line 2",
    )

    const versionOneMessage = {
      ...messageRecord(userMessage("Question")),
      version: 1,
    }
    await writeFile(
      filePath,
      serializeRecords([sessionRecord(sessionInfo()), versionOneMessage]),
      "utf8",
    )
    expect(() => jsonlManager(filePath)).toThrow(
      "Invalid session JSONL record on line 2",
    )

    const extraField = {
      ...sessionRecord(sessionInfo()),
      session: { ...sessionInfo(), extra: true },
    }
    await writeFile(filePath, serializeRecords([extraField]), "utf8")
    expect(() => jsonlManager(filePath)).toThrow(
      "Invalid session JSONL record on line 1",
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("rejects malformed version 2 message payloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "buli-jsonl-"))
  const filePath = join(directory, "sessions.jsonl")

  try {
    const user = userMessage("Question")
    const malformedMessages: readonly unknown[] = [
      { ...user, id: "" },
      { ...user, sessionId: "" },
      { ...user, runId: "" },
      {
        ...assistantMessage("", { completed: true }),
        content: [{
          type: "toolCall",
          toolCallId: "",
          toolName: "read_file",
          input: {},
        }],
      },
      {
        id: "tool-result-1",
        sessionId: "session-1",
        runId: "run-1",
        role: "toolResult",
        toolCallId: "",
        toolName: "read_file",
        content: "Result",
        isError: false,
        createdAt: 2,
      },
      {
        ...toolResultMessage("Result"),
        outcome: "unknown",
      },
      {
        ...toolResultMessage("Result"),
        summary: 42,
      },
      { ...user, extra: true },
      {
        ...assistantMessage("Answer", { completed: true }),
        content: [{ type: "text", text: "Answer", extra: true }],
      },
    ]

    for (const message of malformedMessages) {
      await writeFile(
        filePath,
        serializeRecords([
          sessionRecord(sessionInfo()),
          { recordType: "message", version: 2, message },
        ]),
        "utf8",
      )
      expect(() => jsonlManager(filePath)).toThrow(
        "Invalid session JSONL record on line 2",
      )
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("keeps the latest message ID and repairs a truncated final append", async () => {
  const directory = await mkdtemp(join(tmpdir(), "buli-jsonl-"))
  const filePath = join(directory, "sessions.jsonl")

  try {
    const info = sessionInfo()
    const first = userMessage("First")
    const replacement = userMessage("Replacement")
    const completeContents = serializeRecords([
      sessionRecord(info),
      messageRecord(first),
      messageRecord(replacement),
    ])
    await writeFile(filePath, completeContents, "utf8")
    await appendFile(filePath, '{"unfinished"', "utf8")

    const restored = jsonlManager(filePath)
    expect(restored.getMessages("session-1")).toEqual([replacement])
    expect(await readFile(filePath, "utf8")).toBe(completeContents)

    restored.appendMessage(assistantMessage("Recovered", {
      completed: true,
      createdAt: 2,
    }))
    const reopened = jsonlManager(filePath)
    expect(reopened.getMessages("session-1")).toHaveLength(2)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("appends safely after a valid final record without a newline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "buli-jsonl-"))
  const filePath = join(directory, "sessions.jsonl")

  try {
    const info = sessionInfo()
    const user = userMessage("First")
    await writeFile(
      filePath,
      [sessionRecord(info), messageRecord(user)]
        .map((record) => JSON.stringify(record))
        .join("\n"),
      "utf8",
    )

    const manager = jsonlManager(filePath)
    const assistant = assistantMessage("Second", {
      completed: true,
      createdAt: 2,
    })
    manager.appendMessage(assistant)

    expect(jsonlManager(filePath).getMessages(info.id)).toEqual([
      user,
      assistant,
    ])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("rejects a complete malformed final record", async () => {
  const directory = await mkdtemp(join(tmpdir(), "buli-jsonl-"))
  const filePath = join(directory, "sessions.jsonl")

  try {
    await writeFile(filePath, "not-json\n", "utf8")

    expect(() => jsonlManager(filePath)).toThrow(
      "Invalid session JSONL record on line 1",
    )
    expect(await readFile(filePath, "utf8")).toBe("not-json\n")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("delete removes persisted metadata and messages without affecting other sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "buli-jsonl-"))
  const filePath = join(directory, "sessions.jsonl")

  try {
    const manager = jsonlManager(filePath)
    const firstInfo = sessionInfo("session-1", { title: "First" })
    const secondInfo = sessionInfo("session-2", { title: "Second" })
    const firstMessage = userMessage("First", {
      sessionId: "session-1",
      id: "user-1",
      createdAt: 11,
    })
    const secondMessage = userMessage("Second", {
      sessionId: "session-2",
      id: "user-2",
      createdAt: 22,
    })
    manager.createSession(firstInfo)
    manager.createSession(secondInfo)
    manager.appendMessage(firstMessage)
    manager.appendMessage(secondMessage)

    manager.deleteSession("session-1")

    const persistedSecondInfo = { ...secondInfo, updatedAt: 22 }
    expect(manager.getSessionInfo("session-1")).toBeUndefined()
    expect(manager.getMessages("session-1")).toEqual([])
    expect(manager.getSessionInfo("session-2")).toEqual(persistedSecondInfo)
    expect(manager.getMessages("session-2")).toEqual([secondMessage])
    expect(await jsonlRecords(filePath)).toEqual([
      sessionRecord(persistedSecondInfo),
      messageRecord(secondMessage),
    ])

    const restored = jsonlManager(filePath)
    expect(restored.getSessionInfo("session-1")).toBeUndefined()
    expect(restored.getMessages("session-1")).toEqual([])
    expect(restored.getSessionInfo("session-2")).toEqual(persistedSecondInfo)
    expect(restored.getMessages("session-2")).toEqual([secondMessage])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("derives one stable global log path per canonical workspace", async () => {
  const first = await mkdtemp(join(tmpdir(), "buli-workspace-"))
  const second = await mkdtemp(join(tmpdir(), "buli-workspace-"))

  try {
    const firstPath = defaultSessionFilePath(first)
    expect(firstPath).toBe(defaultSessionFilePath(first))
    expect(firstPath).not.toBe(defaultSessionFilePath(second))
    expect(dirname(firstPath)).toBe(join(homedir(), ".buli", "sessions"))
    expect(firstPath).toMatch(/[a-f0-9]{64}\.jsonl$/)
    expect(firstPath).not.toContain(".v2")
  } finally {
    await Promise.all([
      rm(first, { recursive: true, force: true }),
      rm(second, { recursive: true, force: true }),
    ])
  }
})

test("restores completed turns into the next Agent model request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "buli-jsonl-"))
  const filePath = join(directory, "sessions.jsonl")

  try {
    const stored = jsonlManager(filePath)
    stored.createSession(sessionInfo("session-1", { agentId: "test-agent" }))
    stored.appendMessage(userMessage("Earlier question"))
    stored.appendMessage(assistantMessage("Earlier answer", {
      completed: true,
      createdAt: 2,
    }))

    const requests: IAgentModelRequest[] = []
    const session = new AgentSession({
      agentId: "test-agent",
      sessionId: "session-1",
      manager: jsonlManager(filePath),
      systemPrompt: "System",
      tools: [],
      resolveRunConfiguration: () => ({
        model: {
          async *stream(request) {
            requests.push({
              ...request,
              messages: structuredClone(request.messages),
              tools: structuredClone(request.tools),
            })
            yield { type: "finish", reason: "stop" }
          },
        },
        reasoningEffort: "medium",
      }),
    })

    const run = session.prompt("New question")
    await run.accepted
    await run.settled

    expect(requests[0]?.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ])
    expect(requests[0]?.messages[0]).toMatchObject({
      role: "user",
      content: "Earlier question",
    })
    expect(requests[0]?.messages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Earlier answer" }],
    })

    await session.dispose()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("restores the latest same-anchor checkpoint without deleting history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "buli-jsonl-compaction-"))
  const filePath = join(directory, "sessions.jsonl")

  try {
    const manager = jsonlManager(filePath)
    const user = userMessage("Question", { id: "user-1" })
    const assistant = assistantMessage("Answer", {
      id: "assistant-1",
      completed: true,
    })
    manager.createSession(sessionInfo())
    manager.appendMessage(user)
    manager.appendMessage(assistant)

    const first: ICompactionCheckpoint = {
      id: "checkpoint-1",
      sessionId: "session-1",
      createdAt: 3,
      reason: "manual",
      compactedMessageCount: 2,
      throughMessageId: assistant.id,
      summary: "A deliberately longer checkpoint before recompression.",
    }
    const latest: ICompactionCheckpoint = {
      id: "checkpoint-2",
      sessionId: "session-1",
      createdAt: 4,
      reason: "automatic",
      compactedMessageCount: 2,
      throughMessageId: assistant.id,
      summary: "Short checkpoint.",
      model: { providerId: "test", modelId: "model-1" },
      usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
    }
    manager.saveCompactionCheckpoint(first)
    manager.saveCompactionCheckpoint(latest)

    expect((await jsonlRecords(filePath)).filter((record) => (
      record as { recordType?: string }
    ).recordType === "compaction")).toHaveLength(2)
    const restored = jsonlManager(filePath)
    expect(restored.getMessages("session-1")).toEqual([user, assistant])
    expect(restored.getCompactionCheckpoint("session-1")).toEqual(latest)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("round-trips the latest file-change proposal state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "buli-jsonl-proposals-"))
  const filePath = join(directory, "sessions.jsonl")

  try {
    const manager = jsonlManager(filePath)
    manager.createSession(sessionInfo())
    const pending = fileChangeProposal()
    const applied = fileChangeProposal({
      status: "applied",
      resolvedAt: 4,
    })

    manager.saveFileChangeProposal(pending)
    manager.saveFileChangeProposal(applied)

    const records = await jsonlRecords(filePath)
    expect(records[0]).toEqual(sessionRecord(sessionInfo()))
    expect(records.filter((record) => (
      record as { recordType?: string }
    ).recordType === "fileChangeProposal")).toHaveLength(2)
    expect(jsonlManager(filePath).getFileChangeProposals("session-1"))
      .toEqual([applied])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("expires a restored pending proposal through append-only JSONL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "buli-jsonl-orphaned-proposal-"))
  const filePath = join(directory, "sessions.jsonl")

  try {
    const manager = jsonlManager(filePath)
    manager.createSession(sessionInfo())
    manager.saveFileChangeProposal(fileChangeProposal())
    manager.dispose()

    const restored = jsonlManager(filePath)
    const session = new AgentSession({
      agentId: "test-agent",
      sessionId: "session-1",
      manager: restored,
      systemPrompt: "System",
      resolveRunConfiguration: () => ({
        model: { async *stream() {} },
        reasoningEffort: "medium",
      }),
      tools: [],
      now: () => 5,
    })

    expect(restored.getFileChangeProposals("session-1")).toEqual([
      fileChangeProposal({ status: "expired", resolvedAt: 5 }),
    ])
    expect((await jsonlRecords(filePath)).filter((record) => (
      record as { recordType?: string }
    ).recordType === "fileChangeProposal")).toHaveLength(2)

    await session.dispose()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("opens a session log while another manager is active", async () => {
  const directory = await mkdtemp(join(tmpdir(), "buli-jsonl-shared-"))
  const filePath = join(directory, "sessions.jsonl")

  try {
    const first = jsonlManager(filePath)
    first.createSession(sessionInfo())
    first.appendMessage(userMessage("First"))

    const second = jsonlManager(filePath)
    expect(second.getMessages("session-1")).toHaveLength(1)

    second.dispose()
    first.dispose()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

function jsonlManager(filePath: string): JsonlSessionManager {
  return new JsonlSessionManager({ filePath })
}

async function jsonlRecords(filePath: string): Promise<unknown[]> {
  return (await readFile(filePath, "utf8"))
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown)
}

function serializeRecords(records: readonly unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`
}

function sessionRecord(info: ISessionInfo): {
  readonly recordType: "session"
  readonly version: 2
  readonly session: ISessionInfo
} {
  return {
    recordType: "session",
    version: 2,
    session: structuredClone(info),
  }
}

function messageRecord(message: TAgentMessage): {
  readonly recordType: "message"
  readonly version: 2
  readonly message: TAgentMessage
} {
  return {
    recordType: "message",
    version: 2,
    message: structuredClone(message),
  }
}

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
    createdAt: 3,
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

interface IMessageOptions {
  readonly sessionId?: string
  readonly id?: string
  readonly runId?: string
  readonly createdAt?: number
}

function userMessage(
  content: string,
  options: IMessageOptions = {},
): IUserMessage {
  return {
    id: options.id ?? "user-1",
    sessionId: options.sessionId ?? "session-1",
    runId: options.runId ?? "run-1",
    role: "user",
    source: "prompt",
    content,
    createdAt: options.createdAt ?? 1,
  }
}

function assistantMessage(
  text: string,
  options: IMessageOptions & { readonly completed?: boolean } = {},
): IAssistantMessage {
  return {
    id: options.id ?? "assistant-1",
    sessionId: options.sessionId ?? "session-1",
    runId: options.runId ?? "run-1",
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: options.completed ? "stop" : "pending",
    createdAt: options.createdAt ?? 2,
  }
}

function toolResultMessage(content: string): IToolResultMessage {
  return {
    id: "tool-result-1",
    sessionId: "session-1",
    runId: "run-1",
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "test_tool",
    content,
    isError: false,
    createdAt: 2,
  }
}
