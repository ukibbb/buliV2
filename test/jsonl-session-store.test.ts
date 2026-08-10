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

import type { IBuliMessageWithParts } from "@/domain"
import {
  defaultSessionFilePath,
  JsonlSessionStore,
} from "@/engine/jsonl-session-store"
import type { IBuliUserInteractionRequest } from "@/engine/interaction-driver"
import { SessionEngine } from "@/engine/session-engine"

test("persists users and completed assistants without token snapshots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "buli-jsonl-"))
  const filePath = join(directory, "nested", "sessions.jsonl")

  try {
    const store = new JsonlSessionStore({ filePath })
    store.publish(userMessage("Question"))
    store.publish(assistantMessage("Part"))

    expect(await records(filePath)).toHaveLength(1)

    store.publish(assistantMessage("Complete answer", true))

    expect(await records(filePath)).toHaveLength(2)

    const restored = new JsonlSessionStore({ filePath })
    const history = restored.getHistory("session-1")
    expect(history.map((message) => message.info.role)).toEqual([
      "user",
      "assistant",
    ])
    expect(history[1]?.parts[0]).toMatchObject({
      type: "text",
      text: "Complete answer",
    })
    expect(Object.isFrozen(restored.getSnapshot("session-1"))).toBe(true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("keeps the latest message ID and ignores a truncated final append", async () => {
  const directory = await mkdtemp(join(tmpdir(), "buli-jsonl-"))
  const filePath = join(directory, "sessions.jsonl")

  try {
    const store = new JsonlSessionStore({ filePath })
    store.publish(userMessage("First"))
    store.publish(userMessage("Replacement"))
    await appendFile(filePath, '{"unfinished"', "utf8")

    const restored = new JsonlSessionStore({ filePath })
    const history = restored.getHistory("session-1")
    expect(history).toHaveLength(1)
    expect(history[0]?.parts[0]).toMatchObject({ text: "Replacement" })

    restored.publish(assistantMessage("Recovered", true))
    const reopened = new JsonlSessionStore({ filePath })
    expect(reopened.getHistory("session-1")).toHaveLength(2)
    expect(reopened.getHistory("session-1")[1]?.parts[0]).toMatchObject({
      text: "Recovered",
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("reports JSONL corruption before the final record", async () => {
  const directory = await mkdtemp(join(tmpdir(), "buli-jsonl-"))
  const filePath = join(directory, "sessions.jsonl")

  try {
    const valid = JSON.stringify(userMessage("Question"))
    await writeFile(filePath, `${valid}\nnot-json\n${valid}\n`, "utf8")

    expect(() => new JsonlSessionStore({ filePath })).toThrow(
      "Invalid session JSONL record on line 2",
    )
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

test("includes restored completed turns in the next provider request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "buli-jsonl-"))
  const filePath = join(directory, "sessions.jsonl")

  try {
    const stored = new JsonlSessionStore({ filePath })
    stored.publish(userMessage("Earlier question"))
    stored.publish(assistantMessage("Earlier answer", true))

    const requests: IBuliUserInteractionRequest[] = []
    const engine = new SessionEngine({
      store: new JsonlSessionStore({ filePath }),
      driver: {
        async *interaction(request) {
          requests.push({
            ...request,
            history: structuredClone(request.history),
          })
          yield { type: "finish", reason: "stop" }
        },
      },
    })

    await engine.prompt({
      sessionId: "session-1",
      parts: [{ type: "text", text: "New question" }],
    })

    expect(
      requests[0]?.history.map((message) => message.info.role),
    ).toEqual(["user", "assistant", "user"])
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

function userMessage(text: string): IBuliMessageWithParts {
  return {
    info: {
      id: "user-1",
      sessionId: "session-1",
      role: "user",
      createdAt: 1,
    },
    parts: [{
      id: "user-part-1",
      messageId: "user-1",
      sessionId: "session-1",
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
