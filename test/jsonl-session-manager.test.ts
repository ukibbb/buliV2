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

import type { IAgentModelRequest } from "@/agent/agent-types"
import type { IBuliMessageWithParts } from "@/domain"
import { AgentSession } from "@/session/agent-session"
import {
  defaultSessionFilePath,
  JsonlSessionManager,
} from "@/session/jsonl-session-manager"

test("persists only durable messages in the existing JSONL shape", async () => {
  const directory = await mkdtemp(join(tmpdir(), "buli-jsonl-"))
  const filePath = join(directory, "nested", "sessions.jsonl")

  try {
    const manager = new JsonlSessionManager({ filePath })
    manager.appendMessage(userMessage("Question"))
    expect(() => manager.appendMessage(assistantMessage("Part"))).toThrow(
      "Cannot persist an incomplete assistant message",
    )
    expect(await records(filePath)).toHaveLength(1)

    manager.appendMessage(assistantMessage("Complete answer", true))
    expect(await records(filePath)).toHaveLength(2)

    const restored = new JsonlSessionManager({ filePath })
    const history = restored.getMessages("session-1")
    expect(history.map((message) => message.info.role)).toEqual([
      "user",
      "assistant",
    ])
    expect(history[1]?.parts[0]).toMatchObject({
      type: "text",
      text: "Complete answer",
    })
    expect(JSON.parse((await records(filePath))[1] ?? "null")).toEqual(
      assistantMessage("Complete answer", true),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("keeps the latest message ID and repairs a truncated final append", async () => {
  const directory = await mkdtemp(join(tmpdir(), "buli-jsonl-"))
  const filePath = join(directory, "sessions.jsonl")

  try {
    const manager = new JsonlSessionManager({ filePath })
    manager.appendMessage(userMessage("First"))
    manager.appendMessage(userMessage("Replacement"))
    await appendFile(filePath, '{"unfinished"', "utf8")

    const restored = new JsonlSessionManager({ filePath })
    expect(restored.getMessages("session-1")).toHaveLength(1)
    expect(restored.getMessages("session-1")[0]?.parts[0]).toMatchObject({
      text: "Replacement",
    })

    restored.appendMessage(assistantMessage("Recovered", true))
    const reopened = new JsonlSessionManager({ filePath })
    expect(reopened.getMessages("session-1")).toHaveLength(2)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("reports corruption before the final record", async () => {
  const directory = await mkdtemp(join(tmpdir(), "buli-jsonl-"))
  const filePath = join(directory, "sessions.jsonl")

  try {
    const valid = JSON.stringify(userMessage("Question"))
    await writeFile(filePath, `${valid}\nnot-json\n${valid}\n`, "utf8")

    expect(() => new JsonlSessionManager({ filePath })).toThrow(
      "Invalid session JSONL record on line 2",
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("reset rewrites only the selected session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "buli-jsonl-"))
  const filePath = join(directory, "sessions.jsonl")

  try {
    const manager = new JsonlSessionManager({ filePath })
    manager.appendMessage(userMessage("First", "session-1", "user-1"))
    manager.appendMessage(userMessage("Second", "session-2", "user-2"))

    manager.resetSession("session-1")

    expect(manager.getMessages("session-1")).toEqual([])
    expect(manager.getMessages("session-2")).toHaveLength(1)
    const restored = new JsonlSessionManager({ filePath })
    expect(restored.getMessages("session-1")).toEqual([])
    expect(restored.getMessages("session-2")[0]?.parts[0]).toMatchObject({
      text: "Second",
    })
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
    const stored = new JsonlSessionManager({ filePath })
    stored.appendMessage(userMessage("Earlier question"))
    stored.appendMessage(assistantMessage("Earlier answer", true))

    const requests: IAgentModelRequest[] = []
    const session = new AgentSession({
      sessionId: "session-1",
      manager: new JsonlSessionManager({ filePath }),
      systemPrompt: "System",
      tools: [],
      model: {
        async *stream(request) {
          requests.push({
            ...request,
            history: structuredClone(request.history),
            tools: structuredClone(request.tools),
          })
          yield { type: "finish", reason: "stop" }
        },
      },
    })

    await session.prompt("New question")

    expect(requests[0]?.history.map((message) => message.info.role)).toEqual([
      "user",
      "assistant",
      "user",
    ])
    expect(requests[0]?.history[0]?.parts[0]).toMatchObject({
      text: "Earlier question",
    })
    expect(requests[0]?.history[1]?.parts[0]).toMatchObject({
      text: "Earlier answer",
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

async function records(filePath: string): Promise<string[]> {
  return (await readFile(filePath, "utf8"))
    .split("\n")
    .filter((line) => line.length > 0)
}

function userMessage(
  text: string,
  sessionId = "session-1",
  messageId = "user-1",
): IBuliMessageWithParts {
  return {
    info: { id: messageId, sessionId, role: "user", createdAt: 1 },
    parts: [{
      id: `${messageId}-part`,
      messageId,
      sessionId,
      createdAt: 1,
      type: "text",
      text,
    }],
  }
}

function assistantMessage(
  text: string,
  completed = false,
): IBuliMessageWithParts {
  return {
    info: {
      id: "assistant-1",
      sessionId: "session-1",
      role: "assistant",
      createdAt: 2,
      ...(completed ? { completedAt: 3, finish: "stop" } : {}),
    },
    parts: [{
      id: "assistant-part-1",
      messageId: "assistant-1",
      sessionId: "session-1",
      createdAt: 2,
      type: "text",
      text,
    }],
  }
}
