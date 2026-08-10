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

import { createWorkspaceToolRegistry } from "@/tools/workspace-tools"

test("registers only the existing read-only workspace tools", () => {
  const registry = createWorkspaceToolRegistry()

  expect(registry.definitions().map((tool) => tool.name)).toEqual([
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

    const registry = createWorkspaceToolRegistry()
    const workspaceRoot = await realpath(workspace)
    const context = {
      workspaceRoot,
      signal: new AbortController().signal,
    }

    await expect(registry.execute(
      "read_file",
      { path: "inside.txt" },
      context,
    )).resolves.toBe("inside")
    await expect(registry.execute(
      "read_file",
      { path: relative(workspace, outsideFile) },
      context,
    )).rejects.toThrow("Path is outside the current workspace")
    await expect(registry.execute(
      "read_file",
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

test("stops registry execution when its signal is already aborted", async () => {
  const controller = new AbortController()
  controller.abort(new DOMException("Stopped by test", "AbortError"))
  const registry = createWorkspaceToolRegistry()

  await expect(registry.execute(
    "glob",
    { pattern: "**/*" },
    {
      workspaceRoot: process.cwd(),
      signal: controller.signal,
    },
  )).rejects.toMatchObject({ name: "AbortError", message: "Stopped by test" })
})
