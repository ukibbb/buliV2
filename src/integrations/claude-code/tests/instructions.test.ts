import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { loadClaudeInstructionFiles, loadSystemPromptFile } from "@/integrations/claude-code/instructions"

test("loads the user's then the workspace root CLAUDE.md, leaving .buli to Buli", async () => {
  const workspace = await temporaryWorkspace()
  const home = await temporaryWorkspace("buli-instructions-home-")
  try {
    const userPath = join(home, "CLAUDE.md")
    await writeFile(userPath, "User preferences")
    await writeFile(join(workspace, "CLAUDE.md"), "Project conventions")
    await writeInstruction(workspace, "BULI.md", "Buli conventions")

    expect(await loadClaudeInstructionFiles(await realpath(workspace), userPath, signal())).toEqual([
      { source: userPath, content: "User preferences" },
      { source: "CLAUDE.md", content: "Project conventions" },
    ])
  } finally {
    await Promise.all([removeWorkspace(workspace), removeWorkspace(home)])
  }
})

test("skips missing user and workspace root instructions", async () => {
  const workspace = await temporaryWorkspace()
  try {
    expect(await loadClaudeInstructionFiles(await realpath(workspace), join(workspace, "missing.md"), signal())).toEqual([])
  } finally {
    await removeWorkspace(workspace)
  }
})

test.skipIf(process.platform === "win32")(
  "follows a user instructions symlink outside the workspace but not a workspace root one",
  async () => {
    const workspace = await temporaryWorkspace()
    const dotfiles = await temporaryWorkspace("buli-instructions-dotfiles-")
    try {
      const target = join(dotfiles, "CLAUDE.md")
      await writeFile(target, "Dotfiles preferences")
      const userPath = join(dotfiles, "linked-CLAUDE.md")
      await symlink(target, userPath)

      expect(await loadClaudeInstructionFiles(await realpath(workspace), userPath, signal())).toEqual([
        { source: userPath, content: "Dotfiles preferences" },
      ])

      await symlink(target, join(workspace, "CLAUDE.md"))
      await expect(
        loadClaudeInstructionFiles(await realpath(workspace), userPath, signal()),
      ).rejects.toThrow(/resolve outside the workspace: CLAUDE\.md/)
    } finally {
      await Promise.all([removeWorkspace(workspace), removeWorkspace(dotfiles)])
    }
  },
)

test("follows user @path imports depth-first, skipping code and missing files", async () => {
  const workspace = await temporaryWorkspace()
  const home = await temporaryWorkspace("buli-instructions-home-")
  try {
    const userPath = join(home, "CLAUDE.md")
    const userContent = [
      "User preferences",
      "@./rules\\ dir/stack.md",
      "Mention `@./ignored.md` without importing it.",
      "```",
      "@./ignored.md",
      "```",
      "- list item",
      "  ```",
      "  @./ignored.md",
      "  ```",
      "@./missing.md",
      "See @rules\\ dir/ and @~ in prose.",
      "mail@example.com",
    ].join("\n")
    const stackContent = `Stack\n@${join(home, "nested.md")}`
    await mkdir(join(home, "rules dir"))
    await writeFile(userPath, userContent)
    await writeFile(join(home, "rules dir", "stack.md"), stackContent)
    await writeFile(join(home, "nested.md"), "Nested")
    await writeFile(join(home, "ignored.md"), "Must not load")

    expect(await loadClaudeInstructionFiles(await realpath(workspace), userPath, signal())).toEqual([
      { source: userPath, content: userContent },
      { source: join(home, "rules dir", "stack.md"), content: stackContent },
      { source: join(home, "nested.md"), content: "Nested" },
    ])
  } finally {
    await Promise.all([removeWorkspace(workspace), removeWorkspace(home)])
  }
})

test("resolves ~ imports against the home directory", async () => {
  const workspace = await temporaryWorkspace()
  const home = await temporaryWorkspace("buli-instructions-home-")
  const originalHome = process.env.HOME
  process.env.HOME = home
  try {
    const userPath = join(home, "CLAUDE.md")
    await writeFile(userPath, "@~/stack.md")
    await writeFile(join(home, "stack.md"), "Stack")

    expect(await loadClaudeInstructionFiles(await realpath(workspace), userPath, signal())).toEqual([
      { source: userPath, content: "@~/stack.md" },
      { source: join(home, "stack.md"), content: "Stack" },
    ])
  } finally {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    await Promise.all([removeWorkspace(workspace), removeWorkspace(home)])
  }
})

test("stops imports after four hops and reads each file once", async () => {
  const workspace = await temporaryWorkspace()
  const home = await temporaryWorkspace("buli-instructions-home-")
  try {
    const names = ["0.md", "1.md", "2.md", "3.md", "4.md", "5.md"]
    await Promise.all(names.map((name, index) => {
      const next = names[index + 1]
      return writeFile(join(home, name), next === undefined ? "Too deep" : `@./${next}\n@./0.md`)
    }))

    const files = await loadClaudeInstructionFiles(await realpath(workspace), join(home, "0.md"), signal())
    expect(files.map((file) => file.source)).toEqual(names.slice(0, 5).map((name) => join(home, name)))
  } finally {
    await Promise.all([removeWorkspace(workspace), removeWorkspace(home)])
  }
})

test("reads an appended system prompt file and rejects a missing one", async () => {
  const workspace = await temporaryWorkspace()
  try {
    const path = join(workspace, "system.md")
    await writeFile(path, "System rules")

    expect(await loadSystemPromptFile(path, signal())).toBe("System rules")
    await expect(
      loadSystemPromptFile(join(workspace, "missing.md"), signal()),
    ).rejects.toThrow(/Unable to inspect instructions: .*missing\.md/)
  } finally {
    await removeWorkspace(workspace)
  }
})

function signal(): AbortSignal {
  return new AbortController().signal
}

async function writeInstruction(
  workspace: string,
  fileName: string,
  content: string | Uint8Array,
): Promise<void> {
  const directory = join(workspace, ".buli")
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, fileName), content)
}

async function temporaryWorkspace(prefix = "buli-instructions-"): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix))
}

async function removeWorkspace(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}
