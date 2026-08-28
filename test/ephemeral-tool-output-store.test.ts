import { expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { lstat, readdir, stat } from "node:fs/promises"

import type { IAgentToolContext, IToolOutputIdentity } from "@/agent"
import {
  createToolOutputTool,
  EphemeralToolOutputStore,
} from "@/tools"

test("ephemeral output store keeps private multipart output and exact pages", async () => {
  const store = new EphemeralToolOutputStore()
  try {
    const { outputId } = await store.store(identity(), {
      content: "plain 🙂 text",
      summary: Buffer.from("summary é", "utf8"),
      stdout: new Uint8Array(),
    })

    expect((await page(store, outputId, "content")).content).toBe("plain 🙂 text")
    expect((await page(store, outputId, "summary")).content).toBe("summary é")
    expect(await page(store, outputId, "stdout")).toMatchObject({
      content: "",
      contentBytes: 0,
      totalBytes: 0,
    })
    const root = await store.temporaryRootForTests()
    expect(root).toBeString()
    expect((await stat(root!)).mode & 0o777).toBe(0o700)
    const files = await readdir(root!)
    expect(files).toHaveLength(3)
    for (const file of files) {
      expect((await stat(`${root}/${file}`)).mode & 0o777).toBe(0o600)
    }
    expect(outputId).not.toContain(identity().sessionId)
    expect(outputId).not.toContain(root!)
  } finally {
    await store.dispose()
  }
})

test("ephemeral output pages reconstruct Unicode and obey the line limit", async () => {
  const store = new EphemeralToolOutputStore()
  const source = "🙂 alpha\néclair\nżółć and more\nlast 🙂"
  try {
    const { outputId } = await store.store(identity(), { content: source })
    let offset = 0
    let reconstructed = ""
    for (let count = 0; count < 20; count += 1) {
      const current = await store.readPage({
        sessionId: identity().sessionId,
        outputId,
        part: "content",
        encoding: "text",
        offset,
        maxBytes: 9,
        maxLines: 1,
      })
      expect(current.content).not.toContain("�")
      expect(current.contentBytes).toBe(Buffer.byteLength(current.content, "utf8"))
      expect(current.contentBytes).toBeLessThanOrEqual(9)
      reconstructed += current.content
      if (current.nextOffset === undefined) break
      expect(current.nextOffset).toBeGreaterThan(offset)
      offset = current.nextOffset
    }
    expect(reconstructed).toBe(source)
    await expect(store.readPage({
      sessionId: identity().sessionId,
      outputId,
      part: "content",
      encoding: "text",
      offset: 1,
      maxBytes: 20,
      maxLines: 2,
    })).rejects.toThrow("UTF-8 byte boundary")
  } finally {
    await store.dispose()
  }
})

test("ephemeral output preserves a BOM and offers exact base64 pages for binary bytes", async () => {
  const store = new EphemeralToolOutputStore()
  try {
    const bomText = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("hello", "utf8"),
    ])
    const binary = Buffer.from([0xff, 0x00, 0x80, 0x41, 0x42, 0xfe])
    const { outputId } = await store.store(identity(), {
      content: bomText,
      stdout: binary,
    })
    expect((await page(store, outputId, "content")).content).toBe("\uFEFFhello")
    await expect(store.readPage({
      sessionId: identity().sessionId,
      outputId,
      part: "stdout",
      encoding: "text",
      offset: 0,
      maxBytes: 4,
      maxLines: 10,
    })).rejects.toThrow("encoding=\"base64\"")

    let offset = 0
    const reconstructed: Buffer[] = []
    while (true) {
      const current = await store.readPage({
        sessionId: identity().sessionId,
        outputId,
        part: "stdout",
        encoding: "base64",
        offset,
        maxBytes: 4,
        maxLines: 10,
      })
      reconstructed.push(Buffer.from(current.content, "base64"))
      if (current.nextOffset === undefined) break
      offset = current.nextOffset
    }
    expect(Buffer.concat(reconstructed)).toEqual(binary)
  } finally {
    await store.dispose()
  }
})

test("ephemeral writer preserves stdout and stderr and enforces quotas", async () => {
  const store = new EphemeralToolOutputStore({
    maximumEntryBytes: 18,
    maximumTotalBytes: 24,
  })
  try {
    const writer = await store.createWriter(identity())
    await Promise.all([
      writer.write("stdout", Buffer.from("out-1|")),
      writer.write("stderr", Buffer.from("err-1|")),
      writer.write("stdout", Buffer.from("out-2")),
    ])
    const { outputId } = await writer.commit()
    expect((await page(store, outputId, "stdout")).content).toBe("out-1|out-2")
    expect((await page(store, outputId, "stderr")).content).toBe("err-1|")
    await expect(writer.write("stdout", Buffer.from("late"))).rejects.toThrow(
      "no longer writable",
    )
    await expect(store.store(identity(), { content: "12345678" })).rejects.toThrow(
      "application quota",
    )
  } finally {
    await store.dispose()
  }
})

test("ephemeral writer seals atomically against late writes and concurrent discard", async () => {
  const store = new EphemeralToolOutputStore()
  try {
    const writer = await store.createWriter(identity())
    await writer.write("content", Buffer.from("complete"))
    const commit = writer.commit()
    const discard = writer.discard()
    await expect(writer.write("content", Buffer.from("late"))).rejects.toThrow(
      "no longer writable",
    )
    const { outputId } = await commit
    await discard
    expect((await page(store, outputId, "content")).content).toBe("complete")

    const oneEntryStore = new EphemeralToolOutputStore({ maximumEntries: 1 })
    try {
      await oneEntryStore.store(identity(), { content: "" })
      await expect(oneEntryStore.store(identity(), { content: "" })).rejects.toThrow(
        "entry quota",
      )
    } finally {
      await oneEntryStore.dispose()
    }
  } finally {
    await store.dispose()
  }
})

test("ephemeral output IDs are session-bound and expire with the store lifetime", async () => {
  const store = new EphemeralToolOutputStore()
  const otherLifetime = new EphemeralToolOutputStore()
  try {
    const { outputId } = await store.store(identity("owner"), { content: "secret" })
    await expect(store.readPage({
      sessionId: "other",
      outputId,
      part: "content",
      encoding: "text",
      offset: 0,
      maxBytes: 20,
      maxLines: 2,
    })).rejects.toThrow("unavailable in this session")
    await expect(store.readPage({
      sessionId: "owner",
      outputId,
      part: "stderr",
      encoding: "text",
      offset: 0,
      maxBytes: 20,
      maxLines: 2,
    })).rejects.toThrow("part \"stderr\" is unavailable")
    await expect(otherLifetime.readPage({
      sessionId: "owner",
      outputId,
      part: "content",
      encoding: "text",
      offset: 0,
      maxBytes: 20,
      maxLines: 2,
    })).rejects.toThrow("earlier application lifetime")
  } finally {
    await Promise.all([store.dispose(), otherLifetime.dispose()])
  }
})

test("tool_output exposes strict bounded paging and disposal removes files", async () => {
  const store = new EphemeralToolOutputStore()
  const source = "first line\nsecond line\nthird line"
  const { outputId } = await store.store(identity(), { content: source })
  const root = await store.temporaryRootForTests()
  const tool = createToolOutputTool(store)

  expect(tool.name).toBe("tool_output")
  expect(tool.approvalKind).toBeUndefined()
  expect(tool.inputSchema).toMatchObject({
    type: "object",
    required: ["outputId"],
    additionalProperties: false,
    properties: {
      outputId: { type: "string", minLength: 1, maxLength: 128 },
      encoding: { default: "text" },
      offset: { type: "integer", minimum: 0, default: 0 },
      maxBytes: { type: "integer", maximum: 64 * 1024 },
      maxLines: { type: "integer", maximum: 1500 },
    },
  })
  const first = await tool.execute({
    outputId,
    maxBytes: 20,
    maxLines: 1,
  }, context())
  expect(first).toContain("first line\n")
  expect(first).toContain("[Tool output page complete; continue with")
  expect(first).toContain("offset=11]")
  await expect(tool.execute({ outputId, unexpected: true } as never, context()))
    .rejects.toThrow("unknown property")

  const firstDispose = store.dispose()
  expect(store.dispose()).toBe(firstDispose)
  await firstDispose
  await expect(lstat(root!)).rejects.toMatchObject({ code: "ENOENT" })
  await expect(tool.execute({ outputId }, context())).rejects.toThrow("disposed")
})

async function page(
  store: EphemeralToolOutputStore,
  outputId: string,
  part: "content" | "summary" | "stdout" | "stderr",
) {
  return await store.readPage({
    sessionId: identity().sessionId,
    outputId,
    part,
    encoding: "text",
    offset: 0,
    maxBytes: 1000,
    maxLines: 100,
  })
}

function identity(sessionId = "session-output"): IToolOutputIdentity {
  return {
    sessionId,
    runId: "run-output",
    toolCallId: "call-output",
    toolName: "fixture",
  }
}

function context(): IAgentToolContext {
  return {
    sessionId: identity().sessionId,
    runId: identity().runId,
    toolCallId: "call-page",
    signal: new AbortController().signal,
  }
}
