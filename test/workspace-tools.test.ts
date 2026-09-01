import { expect, test } from "bun:test"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"

import {
  executeToolCallsSequentially,
  indexAgentTools,
} from "@/agent/tool-executor"
import type { IAgentTool, IAgentToolContext } from "@/agent/tool"
import { createWorkspaceTools } from "@/tools"

test("registers the exact Pi-style tool and schema contract", () => {
  const tools = createWorkspaceTools(process.cwd())

  expect(tools.map((tool) => [
    tool.name,
    Object.keys(tool.inputSchema.properties ?? {}),
    tool.inputSchema.required ?? [],
  ])).toEqual([
    ["read", ["path", "offset", "limit"], ["path"]],
    ["find", ["pattern", "path", "limit"], ["pattern"]],
    [
      "grep",
      ["pattern", "path", "glob", "ignoreCase", "literal", "context", "limit"],
      ["pattern"],
    ],
    ["edit", ["path", "edits"], ["path", "edits"]],
    ["write", ["path", "content"], ["path", "content"]],
    ["bash", ["command", "timeout"], ["command"]],
  ])

  const editItems = getTool(tools, "edit").inputSchema.properties.edits.items
  expect(Object.keys(editItems.properties)).toEqual(["oldText", "newText"])
  expect(editItems.required).toEqual(["oldText", "newText"])
  expect(tools.map((tool) => tool.approvalKind)).toEqual([
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  ])
})

test("read is text-only and uses Pi offset and truncation messages", async () => {
  await withFixture(async ({ root, workspace }) => {
    const outside = join(root, "outside")
    await mkdir(join(outside, "directory"), { recursive: true })
    const source = join(outside, "lines.txt")
    await writeFile(source, "one\ntwo\nthree\nfour")
    const read = getTool(createWorkspaceTools(workspace), "read")

    await expect(read.execute({
      path: relative(workspace, source),
      offset: 2,
      limit: 1,
    }, context())).resolves.toBe(
      "two\n\n[2 more lines in file. Use offset=3 to continue.]",
    )
    await expect(read.execute({
      path: source,
      offset: 4,
    }, context())).resolves.toBe("four")
    await expect(read.execute({
      path: join(outside, "directory"),
    }, context())).rejects.toThrow()

    const manyLines = Array.from(
      { length: 2_001 },
      (_, index) => `line-${index + 1}`,
    ).join("\n")
    await writeFile(join(workspace, "many.txt"), manyLines)
    const truncated = await read.execute({ path: "many.txt" }, context())
    expect(textResult(truncated)).toEndWith(
      "\n\n[Showing lines 1-2000 of 2001. Use offset=2001 to continue.]",
    )

    await writeFile(join(workspace, "long.txt"), "x".repeat(50 * 1_024 + 1))
    await expect(read.execute({ path: "long.txt" }, context())).resolves.toBe(
      "[Line 1 is 50.0KB, exceeds 50.0KB limit. Use bash: sed -n '1p' long.txt | head -c 51200]",
    )
  })
})

test("find uses the injected fd executable and accepts a parent-relative path", async () => {
  await withFixture(async ({ root, workspace }) => {
    const outside = join(root, "outside")
    await mkdir(outside)
    const executable = join(root, "fd-fixture")
    const argsLog = join(root, "fd-args.txt")
    await writeExecutable(executable, [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > ${shellLiteral(argsLog)}`,
      "for last do :; done",
      "printf '%s\\n' \"$last/src/alpha.ts\" \"$last/src/beta.ts\"",
      "",
    ].join("\n"))
    const find = getTool(createWorkspaceTools(workspace, {
      fdExecutablePath: executable,
    }), "find")

    await expect(find.execute({
      pattern: "src/*.ts",
      path: relative(workspace, outside),
      limit: 2,
    }, context())).resolves.toEqual({
      content: [
        "src/alpha.ts",
        "src/beta.ts",
        "",
        "[2 results limit reached. Use limit=4 for more, or refine pattern]",
      ].join("\n"),
      summary: "2 files, limit reached",
    })
    expect(await readArguments(argsLog)).toEqual([
      "--glob",
      "--color=never",
      "--hidden",
      "--no-require-git",
      "--max-results",
      "2",
      "--full-path",
      "--",
      "**/src/*.ts",
      outside,
    ])
  })
})

test("grep uses the injected ripgrep executable and truncates lines to 500 chars", async () => {
  await withFixture(async ({ root, workspace }) => {
    const target = join(root, "long.txt")
    const longLine = `needle [${"x".repeat(600)}`
    await writeFile(target, `before\n${longLine}\nafter`)

    const executable = join(root, "rg-fixture")
    const argsLog = join(root, "rg-args.txt")
    const event = JSON.stringify({
      type: "match",
      data: {
        path: { text: target },
        lines: { text: `${longLine}\n` },
        line_number: 2,
      },
    })
    await writeExecutable(executable, [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > ${shellLiteral(argsLog)}`,
      `printf '%s\\n' ${shellLiteral(event)}`,
      "",
    ].join("\n"))
    const grep = getTool(createWorkspaceTools(workspace, {
      ripgrepExecutablePath: executable,
    }), "grep")

    await expect(grep.execute({
      pattern: "NEEDLE [",
      path: target,
      glob: "*.txt",
      ignoreCase: true,
      literal: true,
      context: 1,
      limit: 1,
    }, context())).resolves.toEqual({
      content: [
        "long.txt-1- before",
        `long.txt:2: ${longLine.slice(0, 500)}... [truncated]`,
        "long.txt-3- after",
        "",
        "[1 matches limit reached. Use limit=2 for more, or refine pattern. Some lines truncated to 500 chars. Use read tool to see full lines]",
      ].join("\n"),
      summary: "1 match, limit reached",
    })
    expect(await readArguments(argsLog)).toEqual([
      "--json",
      "--line-number",
      "--color=never",
      "--hidden",
      "--ignore-case",
      "--fixed-strings",
      "--glob",
      "*.txt",
      "--",
      "NEEDLE [",
      target,
    ])
  })
})

test("edit applies fuzzy, disjoint edits while preserving BOM and CRLF", async () => {
  await withFixture(async ({ root, workspace }) => {
    const target = join(root, "outside.txt")
    await writeFile(
      target,
      "\uFEFFalpha  \r\nuntouched  \u201Ccurly\u201D  \r\nmiddle \u201Cquote\u201D\r\nomega\r\n",
    )
    const edit = getTool(createWorkspaceTools(workspace), "edit")

    await expect(edit.execute({
      path: target,
      edits: [
        { oldText: "alpha\n", newText: "ALPHA\n" },
        { oldText: "middle \"quote\"", newText: "CENTER" },
        { oldText: "omega", newText: "OMEGA" },
      ],
    }, context())).resolves.toBe(
      `Successfully replaced 3 block(s) in ${target}.`,
    )
    expect(await readFile(target, "utf8")).toBe(
      "\uFEFFALPHA\r\nuntouched  \u201Ccurly\u201D  \r\nCENTER\r\nOMEGA\r\n",
    )
  })
})

test("agent execution prepares legacy and serialized edit arguments", async () => {
  await withFixture(async ({ workspace }) => {
    const target = join(workspace, "compat.txt")
    await writeFile(target, "first\nsecond\n")
    const edit = getTool(createWorkspaceTools(workspace), "edit")
    let resultId = 0

    const results = await executeToolCallsSequentially([
      {
        type: "toolCall",
        toolCallId: "legacy-edit",
        toolName: "edit",
        input: {
          path: "compat.txt",
          oldText: "first",
          newText: "FIRST",
        },
      },
      {
        type: "toolCall",
        toolCallId: "serialized-edit",
        toolName: "edit",
        input: {
          path: "compat.txt",
          edits: JSON.stringify({ oldText: "second", newText: "SECOND" }),
        },
      },
    ], indexAgentTools([edit]), {
      sessionId: "session-workspace-tools",
      runId: "run-workspace-tools",
      messages: [],
      signal: new AbortController().signal,
      emit: () => {},
      now: () => 1,
      generateId: () => `result-${resultId += 1}`,
    })

    expect(results.map(({ content, isError }) => ({ content, isError }))).toEqual([
      {
        content: "Successfully replaced 1 block(s) in compat.txt.",
        isError: false,
      },
      {
        content: "Successfully replaced 1 block(s) in compat.txt.",
        isError: false,
      },
    ])
    expect(await readFile(target, "utf8")).toBe("FIRST\nSECOND\n")
  })
})

test("write creates parents and overwrites absolute and parent-relative paths", async () => {
  await withFixture(async ({ root, workspace }) => {
    const target = join(root, "outside", "nested", "value.txt")
    const write = getTool(createWorkspaceTools(workspace), "write")

    await expect(write.execute({
      path: relative(workspace, target),
      content: "first",
    }, context())).resolves.toContain("Successfully wrote 5 bytes")
    expect(await readFile(target, "utf8")).toBe("first")

    await expect(write.execute({
      path: target,
      content: "replacement",
    }, context())).resolves.toContain("Successfully wrote 11 bytes")
    expect(await readFile(target, "utf8")).toBe("replacement")
  })
})

function getTool(tools: readonly IAgentTool[], name: string): IAgentTool {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`Expected ${name} tool`)
  return tool
}

function context(): IAgentToolContext {
  return {
    sessionId: "session-workspace-tools",
    toolCallId: "call-workspace-tools",
    runId: "run-workspace-tools",
    messages: [],
    signal: new AbortController().signal,
  }
}

function textResult(result: string | { content: string }): string {
  return typeof result === "string" ? result : result.content
}

async function withFixture(
  run: (fixture: { root: string; workspace: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "buli-workspace-tools-"))
  const workspace = join(root, "workspace")
  await mkdir(workspace)
  try {
    await run({ root, workspace })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function writeExecutable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents)
  await chmod(path, 0o755)
}

async function readArguments(path: string): Promise<string[]> {
  return (await readFile(path, "utf8")).trimEnd().split("\n")
}

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}
