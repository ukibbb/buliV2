import { expect, test } from "bun:test"
import {
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"

import { createWorkspaceTools } from "@/tools/workspace-tools"

test("creates only the existing read-only workspace tools", () => {
  const tools = createWorkspaceTools(process.cwd())

  expect(tools.map((tool) => tool.name)).toEqual([
    "read_file",
    "glob",
    "grep",
  ])
})

test("keeps read_file inside the canonical workspace", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "buli-workspace-"))
  const outside = await mkdtemp(join(tmpdir(), "buli-outside-"))

  try {
    const insideFile = join(workspace, "inside.txt")
    const outsideFile = join(outside, "outside.txt")
    await Promise.all([
      writeFile(insideFile, "inside"),
      writeFile(outsideFile, "outside"),
    ])
    await symlink(outsideFile, join(workspace, "outside-link.txt"))

    const workspaceRoot = await realpath(workspace)
    const tools = createWorkspaceTools(workspaceRoot)
    const readFile = tools.find((tool) => tool.name === "read_file")
    if (!readFile) throw new Error("Expected read_file tool")
    const context = {
      toolCallID: "call-read",
      signal: new AbortController().signal,
    }

    await expect(readFile.execute(
      { path: "inside.txt" },
      context,
    )).resolves.toBe("inside")
    await expect(readFile.execute(
      { path: relative(workspace, outsideFile) },
      context,
    )).rejects.toThrow("Path is outside the current workspace")
    await expect(readFile.execute(
      { path: "outside-link.txt" },
      context,
    )).rejects.toThrow("Path is outside the current workspace")
  } finally {
    await Promise.all([
      rm(workspace, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ])
  }
})

test("stops tool execution when its signal is already aborted", async () => {
  const controller = new AbortController()
  controller.abort(new DOMException("Stopped by test", "AbortError"))
  const glob = createWorkspaceTools(process.cwd())
    .find((tool) => tool.name === "glob")
  if (!glob) throw new Error("Expected glob tool")

  await expect(glob.execute(
    { pattern: "**/*" },
    {
      toolCallID: "call-glob",
      signal: controller.signal,
    },
  )).rejects.toMatchObject({ name: "AbortError", message: "Stopped by test" })
})
