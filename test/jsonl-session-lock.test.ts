import { expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { JsonlSessionManager } from "@/sessions/jsonl/jsonl-session-manager"

const managerImport = `import { JsonlSessionManager } from ${JSON.stringify(
  join(import.meta.dir, "../src/sessions/jsonl/jsonl-session-manager.ts"),
)};`

test("excludes a second process and allows it after the owner disposes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "buli-jsonl-process-lock-"))
  const filePath = join(directory, "sessions.jsonl")
  const owner = new JsonlSessionManager({ filePath })
  const probe = () => Bun.spawnSync([
    process.execPath, "-e",
    `${managerImport}
     try {
       const manager = new JsonlSessionManager({ filePath: process.argv[1] });
       manager.dispose();
     } catch (error) {
       console.error(error.message);
       process.exitCode = 1;
     }`,
    filePath,
  ], { cwd: join(import.meta.dir, "..") })

  try {
    const blocked = probe()
    expect(blocked.exitCode).toBe(1)
    expect(blocked.stderr.toString()).toContain(`Unable to lock session log ${filePath}`)
    expect(probe().exitCode).toBe(1)
    owner.dispose()
    expect(probe().exitCode).toBe(0)
    expect((await stat(`${filePath}.lock`)).mode & 0o077).toBe(0)
  } finally {
    owner.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test("the OS releases log ownership after SIGKILL without stale-lock cleanup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "buli-jsonl-crash-lock-"))
  const filePath = join(directory, "sessions.jsonl")
  const ready = Promise.withResolvers<void>()
  const child = Bun.spawn([
    process.execPath, "-e",
    `${managerImport}
     const manager = new JsonlSessionManager({ filePath: process.argv[1] });
     process.send("locked");
     setInterval(() => manager.listSessions(), 1000);`,
    filePath,
  ], {
    cwd: join(import.meta.dir, ".."),
    stdout: "ignore",
    stderr: "pipe",
    ipc(message) {
      if (message === "locked") ready.resolve()
    },
  })

  try {
    await Promise.race([
      ready.promise,
      child.exited.then(async (code) => {
        throw new Error(`Lock owner exited (${code}): ${await new Response(child.stderr).text()}`)
      }),
    ])
    expect(() => new JsonlSessionManager({ filePath })).toThrow("Unable to lock session log")
    child.kill("SIGKILL")
    await child.exited
    const restored = new JsonlSessionManager({ filePath })
    restored.dispose()
  } finally {
    child.kill("SIGKILL")
    await child.exited
    await rm(directory, { recursive: true, force: true })
  }
})

test("canonicalizes path aliases while allowing independent workspace logs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "buli-jsonl-lock-path-"))
  const realDirectory = join(directory, "real")
  const alias = join(directory, "alias")
  await mkdir(realDirectory)
  await symlink(realDirectory, alias)
  const owner = new JsonlSessionManager({ filePath: join(realDirectory, "sessions.jsonl") })

  try {
    expect(() => new JsonlSessionManager({ filePath: join(alias, "sessions.jsonl") }))
      .toThrow("Unable to lock session log")
    const independent = new JsonlSessionManager({ filePath: join(realDirectory, "other.jsonl") })
    independent.dispose()
  } finally {
    owner.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test("keeps a symlinked log and its ownership stable across rewrites", async () => {
  const directory = await mkdtemp(join(tmpdir(), "buli-jsonl-symlink-lock-"))
  const filePath = join(directory, "sessions.jsonl")
  const alias = join(directory, "alias.jsonl")
  await writeFile(filePath, "")
  await symlink(filePath, alias)
  const owner = new JsonlSessionManager({ filePath: alias })

  try {
    owner.createSession({ id: "session", agentId: "agent", title: "Test", createdAt: 1, updatedAt: 1 })
    owner.appendMessage({
      id: "user", sessionId: "session", runId: "run", role: "user",
      source: "prompt", content: "Question", createdAt: 1,
    })
    expect((await lstat(alias)).isSymbolicLink()).toBe(true)
    expect(() => new JsonlSessionManager({ filePath: alias })).toThrow("Unable to lock session log")
    expect(() => new JsonlSessionManager({ filePath })).toThrow("Unable to lock session log")
    owner.dispose()
    const restored = new JsonlSessionManager({ filePath })
    try {
      expect(restored.getMessages("session")).toHaveLength(1)
    } finally {
      restored.dispose()
    }
  } finally {
    owner.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
