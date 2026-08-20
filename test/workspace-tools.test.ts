import { expect, test } from "bun:test"
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter as PATH_DELIMITER, join, relative } from "node:path"

import type {
  IAgentTool,
  IAgentToolExecutionContext,
} from "@/agent/agent-types"
import { createWorkspaceTools } from "@/tools/workspace-tools"

test("registers workspace tools in model-facing order", () => {
  const tools = createWorkspaceTools(process.cwd())

  expect(tools.map((tool) => tool.name)).toEqual([
    "read",
    "glob",
    "grep",
    "apply_patch",
    "bash",
  ])

  const read = getTool(tools, "read")
  expect(read.inputSchema).toMatchObject({
    type: "object",
    required: ["path"],
    additionalProperties: false,
    properties: {
      path: { type: "string" },
      offset: { type: "integer", minimum: 1, default: 1 },
      limit: { type: "integer", minimum: 1, maximum: 2000, default: 2000 },
    },
  })

  const glob = getTool(tools, "glob")
  expect(glob.inputSchema).toMatchObject({
    required: ["pattern"],
    additionalProperties: false,
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
      hidden: { type: "boolean", default: false },
      limit: { type: "integer", minimum: 1, maximum: 200, default: 100 },
    },
  })

  const grep = getTool(tools, "grep")
  expect(grep.inputSchema).toMatchObject({
    required: ["pattern"],
    additionalProperties: false,
    properties: {
      pattern: { type: "string", minLength: 1 },
      path: { type: "string" },
      include: { type: "string" },
      literal: { type: "boolean", default: false },
      caseSensitive: { type: "boolean", default: true },
      context: { type: "integer", minimum: 0, maximum: 10, default: 0 },
      limit: { type: "integer", minimum: 1, maximum: 200, default: 100 },
    },
  })
})

test("read returns numbered ranges and explicit continuation offsets", async () => {
  const workspace = await temporaryWorkspace()
  try {
    await writeFile(join(workspace, "lines.txt"), "alpha\nbeta\ngamma\n")
    await writeFile(join(workspace, "empty.txt"), "")
    const read = getTool(createWorkspaceTools(workspace), "read")

    await expect(read.execute(
      { path: "lines.txt" },
      context(),
    )).resolves.toBe("1: alpha\n2: beta\n3: gamma")
    await expect(read.execute(
      { path: "lines.txt", offset: 2, limit: 1 },
      context(),
    )).resolves.toBe("2: beta\n... truncated; continue with offset 3")
    await expect(read.execute(
      { path: "lines.txt", offset: 4 },
      context(),
    )).resolves.toBe("Offset 4 is beyond end of file (3 lines)")
    await expect(read.execute(
      { path: "empty.txt" },
      context(),
    )).resolves.toBe("File is empty")
  } finally {
    await removeWorkspace(workspace)
  }
})

test("read caps long lines and total output without losing the next offset", async () => {
  const workspace = await temporaryWorkspace()
  try {
    await writeFile(join(workspace, "long-line.txt"), "x".repeat(5000))
    await writeFile(
      join(workspace, "large.txt"),
      Array.from({ length: 80 }, (_, index) => `${index}-${"y".repeat(1990)}`).join("\n"),
    )
    const read = getTool(createWorkspaceTools(workspace), "read")

    const longLine = textResult(await read.execute({ path: "long-line.txt" }, context()))
    expect([...longLine].length).toBe(2000)
    expect(longLine).toEndWith("... [line truncated]")

    const large = textResult(await read.execute({ path: "large.txt" }, context()))
    expect(Buffer.byteLength(large, "utf8")).toBeLessThanOrEqual(50 * 1024)
    expect(large).toMatch(/\.\.\. truncated; continue with offset \d+$/)
  } finally {
    await removeWorkspace(workspace)
  }
})

test("read lists directories deterministically and marks directories", async () => {
  const workspace = await temporaryWorkspace()
  try {
    await mkdir(join(workspace, "z-directory"))
    await writeFile(join(workspace, "a-file.txt"), "content")
    const read = getTool(createWorkspaceTools(workspace), "read")

    await expect(read.execute({ path: "." }, context())).resolves.toBe(
      "a-file.txt\nz-directory/",
    )
    await expect(read.execute(
      { path: ".", limit: 1 },
      context(),
    )).resolves.toBe("a-file.txt\n... truncated; continue with offset 2")
    await expect(read.execute(
      { path: "z-directory" },
      context(),
    )).resolves.toBe("Directory is empty")
  } finally {
    await removeWorkspace(workspace)
  }
})

test("read rejects likely binary files", async () => {
  const workspace = await temporaryWorkspace()
  try {
    await writeFile(join(workspace, "binary.dat"), Uint8Array.from([65, 0, 66, 1]))
    await writeFile(join(workspace, "document.pdf"), "%PDF-1.7\nprintable header")
    const read = getTool(createWorkspaceTools(workspace), "read")

    await expect(read.execute(
      { path: "binary.dat" },
      context(),
    )).rejects.toThrow("appears to be binary")
    await expect(read.execute(
      { path: "document.pdf" },
      context(),
    )).rejects.toThrow("appears to be binary")
  } finally {
    await removeWorkspace(workspace)
  }
})

test("read rejects regular files larger than 4 MiB before scanning", async () => {
  const workspace = await temporaryWorkspace()
  try {
    const oversized = join(workspace, "oversized.txt")
    await writeFile(oversized, "text")
    await truncate(oversized, 4 * 1024 * 1024 + 1)
    const read = getTool(createWorkspaceTools(workspace), "read")

    await expect(read.execute(
      { path: "oversized.txt" },
      context(),
    )).rejects.toThrow("larger than 4 MiB")
  } finally {
    await removeWorkspace(workspace)
  }
})

test("glob is sorted, scoped, ignore-aware, hidden-aware, and limited", async () => {
  const workspace = await temporaryWorkspace()
  try {
    await Promise.all([
      mkdir(join(workspace, "nested")),
      mkdir(join(workspace, "node_modules")),
      mkdir(join(workspace, ".git")),
    ])
    await Promise.all([
      writeFile(join(workspace, "z.ts"), "z"),
      writeFile(join(workspace, "a.ts"), "a"),
      writeFile(join(workspace, "nested", "b.ts"), "b"),
      writeFile(join(workspace, ".hidden.ts"), "hidden"),
      writeFile(join(workspace, "ignored.ts"), "ignored"),
      writeFile(join(workspace, "node_modules", "blocked.ts"), "blocked"),
      writeFile(join(workspace, ".git", "blocked.ts"), "blocked"),
      writeFile(join(workspace, ".gitignore"), "ignored.ts\n!.hidden.ts\n"),
    ])
    const glob = getTool(createWorkspaceTools(workspace), "glob")

    await expect(glob.execute(
      { pattern: "**/*.ts" },
      context(),
    )).resolves.toBe("a.ts\nnested/b.ts\nz.ts")
    await expect(glob.execute(
      { pattern: "**/*.ts", limit: 2 },
      context(),
    )).resolves.toBe("a.ts\nnested/b.ts\n... results truncated at limit 2")
    await expect(glob.execute(
      { pattern: "*.ts", path: "nested" },
      context(),
    )).resolves.toBe("nested/b.ts")

    const hidden = textResult(await glob.execute(
      { pattern: "**/*.ts", hidden: true },
      context(),
    ))
    expect(hidden.split("\n")).toEqual([".hidden.ts", "a.ts", "nested/b.ts", "z.ts"])
    await expect(glob.execute(
      { pattern: "**/node_modules/**", hidden: true },
      context(),
    )).resolves.toBe("No files found")
    await expect(glob.execute(
      { pattern: "**/.git/**", hidden: true },
      context(),
    )).resolves.toBe("No files found")
    await expect(glob.execute(
      { pattern: "**/*", path: "node_modules", hidden: true },
      context(),
    )).resolves.toBe("No files found")
    await expect(glob.execute(
      { pattern: "**/*", path: ".git", hidden: true },
      context(),
    )).resolves.toBe("No files found")
  } finally {
    await removeWorkspace(workspace)
  }
})

if (process.platform !== "win32") {
  test("glob skips a workspace rg and uses the next safe absolute PATH candidate", async () => {
    const workspace = await temporaryWorkspace()
    const safeRoot = await temporaryWorkspace("buli-safe-rg-")
    try {
      const workspaceBin = join(workspace, "bin")
      const safeBin = join(safeRoot, "bin")
      await Promise.all([mkdir(workspaceBin), mkdir(safeBin)])
      await writeFile(join(workspace, "safe.ts"), "safe")
      await writeExecutable(
        join(workspaceBin, "rg"),
        "#!/bin/sh\n: > workspace-rg-ran\nexit 90\n",
      )
      await writeExecutable(
        join(safeBin, "rg"),
        "#!/bin/sh\n[ \"$1\" = \"--files\" ] || exit 91\nprintf 'safe.ts\\000'\n",
      )
      const searchPath = [
        "",
        "relative-bin",
        workspaceBin,
        safeBin,
        "",
      ].join(PATH_DELIMITER)
      const glob = getTool(createWorkspaceTools(workspace, {
        ripgrepSearchPath: searchPath,
      }), "glob")

      await expect(glob.execute(
        { pattern: "**/*.ts" },
        context(),
      )).resolves.toBe("safe.ts")
      await expect(Bun.file(join(workspace, "workspace-rg-ran")).exists())
        .resolves.toBe(false)
    } finally {
      await Promise.all([removeWorkspace(workspace), removeWorkspace(safeRoot)])
    }
  })

  test("glob errors when PATH has no safe ripgrep executable", async () => {
    const workspace = await temporaryWorkspace()
    try {
      const workspaceBin = join(workspace, "bin")
      await mkdir(workspaceBin)
      await writeExecutable(
        join(workspaceBin, "rg"),
        "#!/bin/sh\n: > workspace-rg-ran\n",
      )
      const glob = getTool(createWorkspaceTools(workspace, {
        ripgrepSearchPath: ["", "relative-bin", workspaceBin].join(PATH_DELIMITER),
      }), "glob")

      await expect(glob.execute(
        { pattern: "**/*" },
        context(),
      )).rejects.toThrow("no safe executable was found on PATH")
      await expect(Bun.file(join(workspace, "workspace-rg-ran")).exists())
        .resolves.toBe(false)
    } finally {
      await removeWorkspace(workspace)
    }
  })
}

test("grep supports include, literal, case, context, limits, and no matches", async () => {
  const workspace = await temporaryWorkspace()
  try {
    await mkdir(join(workspace, "nested"))
    await writeFile(
      join(workspace, "a.ts"),
      "Alpha\nbefore\nneedle here\nafter\nneedle again\n",
    )
    await writeFile(join(workspace, "b.md"), "literal [ token\nNEEDLE upper\n")
    await writeFile(join(workspace, "nested", "scoped.txt"), "scoped-only\n")
    await writeFile(
      join(workspace, "limit-context.txt"),
      "before-first\nhit\nafter-first\nunrelated\nbefore-excluded\nhit\nafter-excluded\n",
    )
    await writeFile(join(workspace, "long.txt"), `longmatch ${"x".repeat(5000)}\n`)
    await writeFile(join(workspace, "ignored.ts"), "needle ignored\n")
    await writeFile(join(workspace, ".gitignore"), "ignored.ts\n")
    const grep = getTool(createWorkspaceTools(workspace), "grep")

    await expect(grep.execute(
      { pattern: "needle", include: "*.ts" },
      context(),
    )).resolves.toBe("a.ts:3: needle here\na.ts:5: needle again")
    await expect(grep.execute(
      { pattern: "alpha", caseSensitive: false },
      context(),
    )).resolves.toBe("a.ts:1: Alpha")
    await expect(grep.execute(
      { pattern: "[", literal: true, include: "*.md" },
      context(),
    )).resolves.toBe("b.md:1: literal [ token")
    await expect(grep.execute(
      { pattern: "needle here", context: 1 },
      context(),
    )).resolves.toBe(
      "a.ts-2- before\na.ts:3: needle here\na.ts-4- after",
    )
    await expect(grep.execute(
      { pattern: "needle", limit: 1 },
      context(),
    )).resolves.toBe("a.ts:3: needle here\n... results truncated at limit 1")
    await expect(grep.execute(
      { pattern: "hit", path: "limit-context.txt", context: 1, limit: 1 },
      context(),
    )).resolves.toBe([
      "limit-context.txt-1- before-first",
      "limit-context.txt:2: hit",
      "limit-context.txt-3- after-first",
      "... results truncated at limit 1",
    ].join("\n"))
    await expect(grep.execute(
      { pattern: "not-present" },
      context(),
    )).resolves.toBe("No matches found")
    await expect(grep.execute(
      { pattern: "scoped-only", path: "nested" },
      context(),
    )).resolves.toBe("nested/scoped.txt:1: scoped-only")

    const longLine = textResult(await grep.execute(
      { pattern: "longmatch", path: "long.txt" },
      context(),
    ))
    expect([...longLine].length).toBe(2000)
    expect(longLine).toEndWith("... [line truncated]")
    await expect(grep.execute(
      { pattern: "[" },
      context(),
    )).rejects.toThrow("Invalid regular expression")
  } finally {
    await removeWorkspace(workspace)
  }
})

test("all tools reject canonical path escapes while accepting workspace paths", async () => {
  const workspace = await temporaryWorkspace()
  const outside = await temporaryWorkspace("buli-outside-")
  try {
    const insideFile = join(workspace, "inside.txt")
    const outsideFile = join(outside, "outside.txt")
    await Promise.all([
      writeFile(insideFile, "inside"),
      writeFile(outsideFile, "outside"),
      writeFile(join(outside, "outside.ts"), "needle"),
    ])
    await Promise.all([
      symlink(insideFile, join(workspace, "inside-link.txt")),
      symlink(outsideFile, join(workspace, "outside-link.txt")),
      symlink(outside, join(workspace, "outside-directory")),
    ])

    const canonicalWorkspace = await realpath(workspace)
    const tools = createWorkspaceTools(canonicalWorkspace)
    const read = getTool(tools, "read")
    const glob = getTool(tools, "glob")
    const grep = getTool(tools, "grep")

    await expect(read.execute({ path: insideFile }, context())).resolves.toBe("1: inside")
    await expect(read.execute(
      { path: "inside-link.txt" },
      context(),
    )).resolves.toBe("1: inside")
    await expect(read.execute(
      { path: relative(workspace, outsideFile) },
      context(),
    )).rejects.toThrow("Path is outside the workspace")
    await expect(read.execute(
      { path: "outside-link.txt" },
      context(),
    )).rejects.toThrow("Path is outside the workspace")
    await expect(glob.execute(
      { pattern: "**/*", path: "outside-directory" },
      context(),
    )).rejects.toThrow("Path is outside the workspace")
    await expect(grep.execute(
      { pattern: "needle", path: outsideFile },
      context(),
    )).rejects.toThrow("Path is outside the workspace")
    await expect(read.execute(
      { path: "missing.txt" },
      context(),
    )).rejects.toThrow("Path does not exist")
  } finally {
    await Promise.all([removeWorkspace(workspace), removeWorkspace(outside)])
  }
})

test("tools reject invalid direct inputs cleanly", async () => {
  const workspace = await temporaryWorkspace()
  try {
    await writeFile(join(workspace, "file.txt"), "text")
    const tools = createWorkspaceTools(workspace)
    const read = getTool(tools, "read")
    const glob = getTool(tools, "glob")
    const grep = getTool(tools, "grep")

    await expect(read.execute(
      { path: "file.txt", offset: 0 },
      context(),
    )).rejects.toThrow("offset must be an integer of at least 1")
    await expect(read.execute(
      { path: "file.txt", limit: 2001 },
      context(),
    )).rejects.toThrow("limit must be at most 2000")
    await expect(glob.execute(
      { pattern: join(workspace, "*.ts") },
      context(),
    )).rejects.toThrow("must be relative")
    await expect(glob.execute(
      { pattern: "../*.ts" },
      context(),
    )).rejects.toThrow("parent segments")
    await expect(glob.execute(
      { pattern: "bad\0pattern" },
      context(),
    )).rejects.toThrow("NUL byte")
    await expect(glob.execute(
      { pattern: "**/*", limit: 0 },
      context(),
    )).rejects.toThrow("limit must be an integer of at least 1")
    await expect(grep.execute(
      { pattern: "" },
      context(),
    )).rejects.toThrow("pattern cannot be empty")
    await expect(grep.execute(
      { pattern: "text", context: 11 },
      context(),
    )).rejects.toThrow("context must be at most 10")
    await expect(grep.execute(
      { pattern: "text", include: "bad\0glob" },
      context(),
    )).rejects.toThrow("NUL byte")
  } finally {
    await removeWorkspace(workspace)
  }
})

test("tools stop before work when already aborted", async () => {
  const workspace = await temporaryWorkspace()
  try {
    await writeFile(join(workspace, "file.txt"), "needle")
    const tools = createWorkspaceTools(workspace)
    const controller = new AbortController()
    controller.abort(new DOMException("Stopped by test", "AbortError"))
    const abortedContext = context(controller.signal)

    for (const [name, input] of [
      ["read", { path: "file.txt" }],
      ["glob", { pattern: "**/*" }],
      ["grep", { pattern: "needle" }],
    ] as const) {
      await expect(getTool(tools, name).execute(
        input,
        abortedContext,
      )).rejects.toMatchObject({ name: "AbortError", message: "Stopped by test" })
    }
  } finally {
    await removeWorkspace(workspace)
  }
})

function getTool(tools: readonly IAgentTool[], name: string): IAgentTool {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`Expected ${name} tool`)
  return tool
}

function textResult(
  result: Awaited<ReturnType<IAgentTool["execute"]>>,
): string {
  if (typeof result !== "string") return result.content
  return result
}

function context(
  signal: AbortSignal = new AbortController().signal,
): IAgentToolExecutionContext {
  return {
    toolCallId: "call-workspace-tool",
    runId: "run-workspace-tool",
    signal,
  }
}

async function temporaryWorkspace(prefix = "buli-workspace-"): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix))
}

async function removeWorkspace(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

async function writeExecutable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents)
  await chmod(path, 0o755)
}
