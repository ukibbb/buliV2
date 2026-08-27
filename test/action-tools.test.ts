import { expect, test } from "bun:test"
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"

import type {
  AgentToolContext,
  AgentToolResult,
  ToolApprovalDecision,
  ToolApprovalDraft,
} from "@/agent"
import { createApplyPatchTool, createBashTool } from "@/tools"
import { StaleWorkspacePatchError } from "@/tools/patch/patch-engine"
import { PROCESS_INTERPRETER_DISPLAY } from "@/tools/command/process-runner"

test("action tools publish bounded strict schemas", () => {
  const applyPatch = createApplyPatchTool(process.cwd())
  expect(applyPatch.name).toBe("apply_patch")
  expect(applyPatch.description).toContain("*** Begin Patch")
  expect(applyPatch.description).toContain("before changing any file")
  expect(applyPatch.description.indexOf("*** Move to:")).toBeGreaterThan(
    applyPatch.description.indexOf("*** Update File:"),
  )
  expect(applyPatch.description.indexOf("@@ optional exact anchor")).toBeGreaterThan(
    applyPatch.description.indexOf("*** Move to:"),
  )
  expect(applyPatch.inputSchema).toMatchObject({
    type: "object",
    required: ["patchText", "explanation"],
    additionalProperties: false,
    properties: {
      patchText: { type: "string", minLength: 1 },
      explanation: { type: "string", minLength: 1 },
    },
  })

  const bash = createBashTool(process.cwd())
  expect(bash.name).toBe("bash")
  expect(bash.inputSchema).toMatchObject({
    type: "object",
    required: [
      "command",
      "purpose",
      "explanation",
      "expectedOutcome",
      "sideEffects",
    ],
    additionalProperties: false,
    properties: {
      command: { type: "string", minLength: 1 },
      purpose: { type: "string", minLength: 1 },
      explanation: { type: "string", minLength: 1 },
      expectedOutcome: { type: "string", minLength: 1 },
      sideEffects: { type: "string", minLength: 1 },
      cwd: { type: "string", minLength: 1, default: "." },
      timeout: { type: "integer", minimum: 1, maximum: 3600, default: 600 },
    },
  })
})

test("action tools validate direct input before requesting approval", async () => {
  const workspace = await temporaryWorkspace()
  let approvals = 0
  const executionContext = context({
    requestApproval: async () => {
      approvals += 1
      return "approve"
    },
  })
  try {
    const applyPatch = createApplyPatchTool(workspace)
    await expect(applyPatch.execute({
      patchText: patchText("*** Add File: added.txt\n+content"),
      explanation: "Add a fixture",
      unexpected: true,
    } as Parameters<typeof applyPatch.execute>[0], executionContext)).rejects.toThrow(
      "unknown property",
    )
    await expect(applyPatch.execute({
      patchText: patchText("*** Add File: added.txt\n+content"),
      explanation: "   ",
    }, executionContext)).rejects.toThrow("explanation cannot be empty")

    const bash = createBashTool(workspace)
    await expect(bash.execute(
      bashInput("exit 0", { timeout: 3601 }),
      executionContext,
    )).rejects.toThrow("timeout must be at most 3600")
    await expect(bash.execute(
      {
        ...bashInput("exit 0"),
        extra: "not allowed",
      } as Parameters<typeof bash.execute>[0],
      executionContext,
    )).rejects.toThrow("unknown property")

    expect(approvals).toBe(0)
    await expect(bash.execute(
      bashInput("exit 0", { timeout: 3600 }),
      context({
        requestApproval: async (draft) => {
          if (draft.kind !== "command") throw new Error("Expected command approval")
          expect(draft.timeoutSeconds).toBe(3600)
          return "reject"
        },
      }),
    )).resolves.toMatchObject({ outcome: "rejected" })
    expect(await pathExists(join(workspace, "added.txt"))).toBe(false)
  } finally {
    await removeWorkspace(workspace)
  }
})

test("apply_patch shows the exact plan before mutation and applies only after approve", async () => {
  const workspace = await temporaryWorkspace()
  const file = join(workspace, "file.txt")
  const approval = Promise.withResolvers<ToolApprovalDecision>()
  const requested = Promise.withResolvers<void>()
  const drafts: ToolApprovalDraft[] = []
  try {
    await writeFile(file, "before\n")
    const tool = createApplyPatchTool(workspace)
    const task = tool.execute({
      patchText: patchText(`*** Update File: file.txt
@@
-before
+after`),
      explanation: "Replace the fixture value",
    }, context({
      requestApproval: async (draft) => {
        drafts.push(draft)
        requested.resolve()
        return await approval.promise
      },
    }))

    await requested.promise
    expect(await readFile(file, "utf8")).toBe("before\n")
    expect(await readdir(workspace)).toEqual(["file.txt"])
    const draft = drafts[0]
    if (!draft || draft.kind !== "patch") throw new Error("Expected patch approval")
    expect(draft).toEqual({
      kind: "patch",
      title: "Apply workspace patch: 1 file changed, 1 insertion(+), 1 deletion(-)",
      explanation: "Replace the fixture value",
      diff: "--- a/file.txt\n+++ b/file.txt\n@@ -1,1 +1,1 @@\n-before\n+after\n",
      paths: ["file.txt"],
    })

    approval.resolve("approve")
    await expect(task).resolves.toEqual({
      content: "Applied workspace patch: 1 file changed, 1 insertion(+), 1 deletion(-)",
      outcome: "completed",
      summary: "Applied workspace patch: 1 file changed, 1 insertion(+), 1 deletion(-)",
    })
    expect(await readFile(file, "utf8")).toBe("after\n")
    expect(await readdir(workspace)).toEqual(["file.txt"])
  } finally {
    await removeWorkspace(workspace)
  }
})

test("apply_patch rejection and unsupported decisions never mutate", async () => {
  const workspace = await temporaryWorkspace()
  try {
    const tool = createApplyPatchTool(workspace)
    const rejected = await tool.execute({
      patchText: patchText("*** Add File: rejected.txt\n+content"),
      explanation: "Propose a rejected file",
    }, context({ requestApproval: async () => "reject" }))
    expect(rejected).toEqual({
      content: "Patch approval was rejected; no workspace files were changed.",
      outcome: "rejected",
      summary: "Patch rejected; workspace unchanged",
    })
    expect(await pathExists(join(workspace, "rejected.txt"))).toBe(false)

    await expect(tool.execute({
      patchText: patchText("*** Add File: copied.txt\n+content"),
      explanation: "Propose a copied patch",
    }, context({ requestApproval: async () => "copy" }))).rejects.toThrow(
      "requires an approve decision",
    )
    expect(await pathExists(join(workspace, "copied.txt"))).toBe(false)
  } finally {
    await removeWorkspace(workspace)
  }
})

test("apply_patch rejects oversized approval diffs without mutation", async () => {
  const workspace = await temporaryWorkspace()
  let approvals = 0
  try {
    const tool = createApplyPatchTool(workspace)
    await expect(tool.execute({
      patchText: patchText(
        `*** Add File: too-large.txt\n+${"x".repeat(500 * 1024)}`,
      ),
      explanation: "Propose an intentionally oversized fixture",
    }, context({
      requestApproval: async () => {
        approvals += 1
        return "approve"
      },
    }))).rejects.toThrow(/500 KiB limit.*Split the work/)

    expect(approvals).toBe(0)
    expect(await pathExists(join(workspace, "too-large.txt"))).toBe(false)
  } finally {
    await removeWorkspace(workspace)
  }
})

test("apply_patch rejects a stale approved plan without overwriting newer content", async () => {
  const workspace = await temporaryWorkspace()
  const file = join(workspace, "file.txt")
  try {
    await writeFile(file, "before\n")
    const tool = createApplyPatchTool(workspace)
    const task = tool.execute({
      patchText: patchText(`*** Update File: file.txt
@@
-before
+approved`),
      explanation: "Update the fixture",
    }, context({
      requestApproval: async () => {
        await writeFile(file, "newer external content\n")
        return "approve"
      },
    }))

    await expect(task).rejects.toBeInstanceOf(StaleWorkspacePatchError)
    expect(await readFile(file, "utf8")).toBe("newer external content\n")
  } finally {
    await removeWorkspace(workspace)
  }
})

test("bash shows exact command details and starts no process before reject", async () => {
  const workspace = await temporaryWorkspace()
  const nested = join(workspace, "nested")
  const marker = join(workspace, "ran.txt")
  const approval = Promise.withResolvers<ToolApprovalDecision>()
  const requested = Promise.withResolvers<void>()
  const drafts: ToolApprovalDraft[] = []
  try {
    await mkdir(nested)
    const command = bunCommand(`await Bun.write(${JSON.stringify(marker)}, "ran")`)
    const tool = createBashTool(workspace)
    const task = tool.execute(bashInput(command, {
      cwd: "nested",
      purpose: "Create a temporary marker",
      explanation: "Exercise approval gating",
      expectedOutcome: "A marker file appears",
      sideEffects: "Writes ran.txt in the temporary workspace",
    }), context({
      requestApproval: async (draft) => {
        drafts.push(draft)
        requested.resolve()
        return await approval.promise
      },
    }))

    await requested.promise
    expect(await pathExists(marker)).toBe(false)
    const draft = drafts[0]
    if (!draft || draft.kind !== "command") throw new Error("Expected command approval")
    expect(draft).toEqual({
      kind: "command",
      title: `Command proposal (${PROCESS_INTERPRETER_DISPLAY})`,
      explanation: "Exercise approval gating",
      command,
      cwd: await realpath(nested),
      purpose: "Create a temporary marker",
      expectedOutcome: "A marker file appears",
      sideEffects: "Writes ran.txt in the temporary workspace",
      timeoutSeconds: 600,
    })

    approval.resolve("reject")
    await expect(task).resolves.toEqual({
      content: "Command approval was rejected; no process was started.",
      outcome: "rejected",
      summary: "Command rejected; no process started",
    })
    expect(await pathExists(marker)).toBe(false)
  } finally {
    await removeWorkspace(workspace)
  }
})

test("bash copy delegates manual execution without starting a process", async () => {
  const workspace = await temporaryWorkspace()
  const marker = join(workspace, "copied.txt")
  try {
    const command = bunCommand(`await Bun.write(${JSON.stringify(marker)}, "ran")`)
    const tool = createBashTool(workspace)
    await expect(tool.execute(
      bashInput(command),
      context({ requestApproval: async () => "copy" }),
    )).resolves.toEqual({
      content: "The command was copied for manual execution; no process was started.",
      outcome: "manual",
      summary: "Command copied; run it manually and share the result",
    })
    expect(await pathExists(marker)).toBe(false)
  } finally {
    await removeWorkspace(workspace)
  }
})

test.skipIf(process.platform === "win32")(
  "bash reports successful and nonzero executions with distinct outcomes",
  async () => {
    const workspace = await temporaryWorkspace()
    const nested = join(workspace, "nested")
    const progress: string[] = []
    try {
      await mkdir(nested)
      const tool = createBashTool(workspace)
      const successfulResult = structuredToolResult(await tool.execute(bashInput(bunCommand(
        'process.stdout.write("hello stdout"); process.stderr.write("hello stderr")',
      ), { cwd: "nested" }), context({
        requestApproval: async () => "approve",
        reportProgress: (value) => progress.push(value),
      })))
      const successful = successfulResult.content

      expect(successfulResult.outcome).toBe("completed")
      expect(successfulResult.summary).toBe("Command exited with code 0")
      expect(successful).toContain(`cwd: ${JSON.stringify(await realpath(nested))}`)
      expect(successful).toContain("exit code: 0")
      expect(successful).toContain("timed out: no")
      expect(successful).toContain("stdout:\nhello stdout")
      expect(successful).toContain("stderr:\nhello stderr")
      expect(progress).toEqual([])

      const nonzeroResult = structuredToolResult(await tool.execute(bashInput(bunCommand(
        'process.stderr.write("expected failure"); process.exitCode = 7',
      )), context({ requestApproval: async () => "approve" })))
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
        context({ requestApproval: async () => "approve" }),
      ))
      const result = execution.content

      expect(execution.outcome).toBe("effects-unknown")
      expect(execution.summary).toBe(
        "Command timed out after 1 seconds; inspect side effects before retrying with a larger timeout of at most 3600 seconds",
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

test("bash rejects workspace escapes and non-directory cwd before approval", async () => {
  const workspace = await temporaryWorkspace()
  const outside = await temporaryWorkspace("buli-action-outside-")
  const file = join(workspace, "file.txt")
  const marker = join(outside, "escaped.txt")
  let approvals = 0
  const executionContext = context({
    requestApproval: async () => {
      approvals += 1
      return "approve"
    },
  })
  try {
    await writeFile(file, "not a directory")
    const command = bunCommand(`await Bun.write(${JSON.stringify(marker)}, "ran")`)
    const tool = createBashTool(workspace)
    await expect(tool.execute(
      bashInput(command, { cwd: relative(workspace, outside) }),
      executionContext,
    )).rejects.toThrow("Path is outside the workspace")
    await expect(tool.execute(
      bashInput(command, { cwd: "file.txt" }),
      executionContext,
    )).rejects.toThrow("cwd is not a directory")

    expect(approvals).toBe(0)
    expect(await pathExists(marker)).toBe(false)
  } finally {
    await Promise.all([removeWorkspace(workspace), removeWorkspace(outside)])
  }
})

test("bash rejects a same-path cwd replacement after approval", async () => {
  const workspace = await temporaryWorkspace()
  const nested = join(workspace, "nested")
  const moved = join(workspace, "approved-directory-moved")
  const marker = join(workspace, "cwd-replacement-ran.txt")
  try {
    await mkdir(nested)
    const command = bunCommand(`await Bun.write(${JSON.stringify(marker)}, "ran")`)
    const tool = createBashTool(workspace)

    await expect(tool.execute(
      bashInput(command, { cwd: "nested" }),
      context({
        requestApproval: async () => {
          await rename(nested, moved)
          await mkdir(nested)
          return "approve"
        },
      }),
    )).rejects.toThrow("working directory identity changed")
    expect(await pathExists(marker)).toBe(false)
  } finally {
    await removeWorkspace(workspace)
  }
})

test("action tools fail clearly when approval is unavailable", async () => {
  const workspace = await temporaryWorkspace()
  const marker = join(workspace, "ran.txt")
  try {
    const applyPatch = createApplyPatchTool(workspace)
    await expect(applyPatch.execute({
      patchText: patchText("*** Add File: unavailable.txt\n+content"),
      explanation: "Requires unavailable approval",
    }, context())).rejects.toThrow("tool approval is unavailable")
    expect(await pathExists(join(workspace, "unavailable.txt"))).toBe(false)

    const bash = createBashTool(workspace)
    await expect(bash.execute(
      bashInput(bunCommand(`await Bun.write(${JSON.stringify(marker)}, "ran")`)),
      context(),
    )).rejects.toThrow("tool approval is unavailable")
    expect(await pathExists(marker)).toBe(false)
  } finally {
    await removeWorkspace(workspace)
  }
})

interface IContextOptions {
  readonly signal?: AbortSignal
  readonly reportProgress?: (progress: string) => void
  readonly requestApproval?: (
    draft: ToolApprovalDraft,
  ) => Promise<ToolApprovalDecision>
}

function context(options: IContextOptions = {}): AgentToolContext {
  return {
    sessionId: "session-action-tool",
    toolCallId: "call-action-tool",
    runId: "run-action-tool",
    messages: [],
    signal: options.signal ?? new AbortController().signal,
    ...(options.reportProgress === undefined
      ? {}
      : { reportProgress: options.reportProgress }),
    ...(options.requestApproval === undefined
      ? {}
      : { requestApproval: options.requestApproval }),
  }
}

function structuredToolResult(
  result: string | AgentToolResult,
): AgentToolResult {
  if (typeof result === "string") throw new Error("Expected a structured tool result")
  return result
}

function patchText(body: string): string {
  return `*** Begin Patch\n${body}\n*** End Patch`
}

interface BashInput {
  readonly command: string
  readonly purpose: string
  readonly explanation: string
  readonly expectedOutcome: string
  readonly sideEffects: string
  readonly cwd?: string
  readonly timeout?: number
}

function bashInput(
  command: string,
  overrides: Partial<BashInput> = {},
): BashInput {
  return {
    command,
    purpose: "Exercise the shell tool",
    explanation: "Run a bounded temporary-workspace command",
    expectedOutcome: "The command returns an observed result",
    sideEffects: "No effects outside the temporary workspace",
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
