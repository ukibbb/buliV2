import { expect, test } from "bun:test"
import {
  lstat,
  mkdtemp,
  realpath,
  rm,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type {
  IAgentToolContext,
  IAgentToolResult,
  IToolOutputStore,
} from "@/agent"
import {
  createBashTool,
  EphemeralToolOutputStore,
} from "@/tools"

const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1_000

test("bash publishes the Pi command and optional timeout schema", () => {
  const bash = createBashTool(process.cwd())
  expect(bash.name).toBe("bash")
  expect(bash.inputSchema as unknown).toEqual({
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute" },
      timeout: {
        type: "number",
        description: "Timeout in seconds (optional, no default timeout)",
      },
    },
    required: ["command"],
  })
  expect(bash.approvalKind).toBeUndefined()
})

test("bash validates direct input before starting a process", async () => {
  const workspace = await temporaryWorkspace()
  const marker = join(workspace, "invalid-input-ran.txt")
  const command = bunCommand(`await Bun.write(${JSON.stringify(marker)}, "ran")`)
  try {
    const bash = createBashTool(workspace)
    await expect(bash.execute(
      bashInput(command, { timeout: MAX_TIMEOUT_SECONDS + 0.001 }),
      context(),
    )).rejects.toThrow(`timeout must be at most ${MAX_TIMEOUT_SECONDS} seconds`)
    await expect(bash.execute(
      bashInput(command, { timeout: 0 }),
      context(),
    )).rejects.toThrow("timeout must be a finite number greater than 0")
    await expect(bash.execute(
      bashInput(command, { timeout: Number.POSITIVE_INFINITY }),
      context(),
    )).rejects.toThrow("timeout must be a finite number greater than 0")
    await expect(bash.execute(
      {
        ...bashInput(command),
        cwd: ".",
      } as Parameters<typeof bash.execute>[0],
      context(),
    )).rejects.toThrow("unknown property")

    expect(await pathExists(marker)).toBe(false)
  } finally {
    await removeWorkspace(workspace)
  }
})

test.skipIf(process.platform === "win32")(
  "bash executes directly in the workspace root with an optional fractional timeout",
  async () => {
    const workspace = await temporaryWorkspace()
    const progress: string[] = []
    try {
      const tool = createBashTool(workspace)
      const successfulResult = structuredToolResult(await tool.execute(bashInput(bunCommand(
        'process.stdout.write(process.cwd()); process.stderr.write("hello stderr")',
      ), { timeout: 1.5 }), context({
        reportProgress: (value) => progress.push(value),
      })))
      const successful = successfulResult.content

      expect(successfulResult.outcome).toBe("completed")
      expect(successfulResult.summary).toBe("Command exited with code 0")
      expect(successful).toContain(`cwd: ${JSON.stringify(workspace)}`)
      expect(successful).toContain("exit code: 0")
      expect(successful).toContain("timed out: no")
      expect(successful).toContain(`stdout:\n${workspace}`)
      expect(successful).toContain("stderr:\nhello stderr")
      expect(progress).toEqual([])

      const nonzeroResult = structuredToolResult(await tool.execute(bashInput(bunCommand(
        'process.stderr.write("expected failure"); process.exitCode = 7',
      )), context()))
      const nonzero = nonzeroResult.content
      expect(nonzeroResult.outcome).toBe("failed")
      expect(nonzeroResult.summary).toBe("Command exited with code 7")
      expect(nonzero).toContain("exit code: 7")
      expect(nonzero).toContain("stderr:\nexpected failure")
    } finally {
      await removeWorkspace(workspace)
    }
  },
)

test.skipIf(process.platform === "win32")(
  "bash reports a stable timeout result",
  async () => {
    const workspace = await temporaryWorkspace()
    try {
      const tool = createBashTool(workspace)
      const execution = structuredToolResult(await tool.execute(
        bashInput(bunCommand("await Bun.sleep(10_000)"), { timeout: 1 }),
        context(),
      ))
      const result = execution.content

      expect(execution.outcome).toBe("effects-unknown")
      expect(execution.summary).toBe(
        `Command timed out after 1 seconds; inspect side effects before retrying with a larger timeout of at most ${MAX_TIMEOUT_SECONDS} seconds`,
      )
      expect(result).toContain("exit code: 124")
      expect(result).toContain("timed out: yes (limit: 1 seconds)")
      expect(result).toContain("stdout:\n(empty)")
      expect(result).toContain("stderr:\n(empty)")
      expect(result).toContain("side effects and detached process state may be unknown")
    } finally {
      await removeWorkspace(workspace)
    }
  },
)

test.skipIf(process.platform === "win32")(
  "bash stores complete stdout and stderr before returning bounded previews",
  async () => {
    const workspace = await temporaryWorkspace()
    const store = new EphemeralToolOutputStore()
    try {
      const stdout = `stdout-start|${"o".repeat(70_000)}|stdout-end`
      const stderr = `stderr-start|${"e".repeat(70_000)}|stderr-end`
      const tool = createBashTool(workspace, store)
      const execution = structuredToolResult(await tool.execute(
        bashInput(bunCommand(
          `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)})`,
        )),
        context(),
      ))

      expect(execution.outcome).toBe("completed")
      expect(execution.content).toContain("stdout preview:")
      expect(execution.content).toContain("stderr preview:")
      const outputId = /complete outputId: (\S+)/.exec(execution.content)?.[1]
      expect(outputId).toBeString()
      expect((await store.readPage({
        sessionId: "session-action-tool",
        outputId: outputId!,
        part: "stdout",
        encoding: "text",
        offset: 0,
        maxBytes: 100_000,
        maxLines: 10,
      })).content).toBe(stdout)
      expect((await store.readPage({
        sessionId: "session-action-tool",
        outputId: outputId!,
        part: "stderr",
        encoding: "text",
        offset: 0,
        maxBytes: 100_000,
        maxLines: 10,
      })).content).toBe(stderr)
    } finally {
      await Promise.all([store.dispose(), removeWorkspace(workspace)])
    }
  },
)

test.skipIf(process.platform === "win32")(
  "bash retains small non-UTF-8 output as exact base64",
  async () => {
    const workspace = await temporaryWorkspace()
    const store = new EphemeralToolOutputStore()
    try {
      const tool = createBashTool(workspace, store)
      const execution = structuredToolResult(await tool.execute(
        bashInput("printf '\\377'"),
        context(),
      ))

      expect(execution.outcome).toBe("completed")
      expect(execution.content).toContain("stdout lossy UTF-8 preview:\n�")
      expect(execution.content).toContain('use encoding="base64"')
      const outputId = /complete outputId: (\S+)/.exec(execution.content)?.[1]
      expect(outputId).toBeString()
      expect((await store.readPage({
        sessionId: "session-action-tool",
        outputId: outputId!,
        part: "stdout",
        encoding: "base64",
        offset: 0,
        maxBytes: 100,
        maxLines: 10,
      })).content).toBe("/w==")
    } finally {
      await Promise.all([store.dispose(), removeWorkspace(workspace)])
    }
  },
)

test.skipIf(process.platform === "win32")(
  "bash marks side effects unknown when temporary output cleanup fails",
  async () => {
    const workspace = await temporaryWorkspace()
    const store: IToolOutputStore = {
      store: async () => ({ outputId: "unused" }),
      createWriter: async () => ({
        write: async () => {},
        commit: async () => ({ outputId: "unused" }),
        discard: async () => {
          throw new Error("discard failed")
        },
      }),
      readPage: async () => {
        throw new Error("unused")
      },
      dispose: async () => {},
    }
    try {
      const tool = createBashTool(workspace, store)
      let failure: unknown
      try {
        await tool.execute(
          bashInput("exit 0"),
          context(),
        )
      } catch (error) {
        failure = error
      }

      expect(failure).toMatchObject({ sideEffectsUnknown: true })
      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).toContain(
        "Bash completed, but its temporary output could not be discarded",
      )
    } finally {
      await removeWorkspace(workspace)
    }
  },
)

interface IContextOptions {
  readonly signal?: AbortSignal
  readonly reportProgress?: (progress: string) => void
}

function context(options: IContextOptions = {}): IAgentToolContext {
  return {
    sessionId: "session-action-tool",
    toolCallId: "call-action-tool",
    runId: "run-action-tool",
    messages: [],
    signal: options.signal ?? new AbortController().signal,
    ...(options.reportProgress === undefined
      ? {}
      : { reportProgress: options.reportProgress }),
  }
}

function structuredToolResult(
  result: string | IAgentToolResult,
): IAgentToolResult {
  if (typeof result === "string") throw new Error("Expected a structured tool result")
  return result
}

interface BashInput {
  readonly command: string
  readonly timeout?: number
}

function bashInput(
  command: string,
  overrides: Partial<BashInput> = {},
): BashInput {
  return {
    command,
    ...overrides,
  }
}

function bunCommand(source: string): string {
  const encodedSource = Buffer.from(`(async()=>{${source}})()`, "utf8").toString("hex")
  const loader = `await eval(Buffer.from('${encodedSource}','hex').toString())`
  return `${quoteShellArgument(process.execPath)} -e ${quoteShellArgument(loader)}`
}

function quoteShellArgument(value: string): string {
  if (process.platform === "win32") return `"${value.replaceAll('"', '""')}"`
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function temporaryWorkspace(prefix = "buli-action-tool-"): Promise<string> {
  return await realpath(await mkdtemp(join(tmpdir(), prefix)))
}

async function removeWorkspace(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}
