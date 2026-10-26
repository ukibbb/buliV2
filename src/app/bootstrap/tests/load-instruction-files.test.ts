import { expect, test } from "bun:test"
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  INSTRUCTION_FILE_MAX_BYTES,
  loadInstructionFiles,
  loadSystemPromptFile,
} from "@/app/bootstrap/load-instruction-files"

test("loads user, workspace root, and .buli instructions in that order", async () => {
  const workspace = await temporaryWorkspace()
  const home = await temporaryWorkspace("buli-instructions-home-")
  try {
    const userPath = join(home, "CLAUDE.md")
    await writeFile(userPath, "User preferences")
    await writeFile(join(workspace, "CLAUDE.md"), "Project conventions")
    await writeInstruction(workspace, "BULI.md", "Buli conventions")

    expect(await loadInstructionFiles(await realpath(workspace), userPath, signal())).toEqual([
      { source: userPath, content: "User preferences" },
      { source: "CLAUDE.md", content: "Project conventions" },
      { source: ".buli/BULI.md", content: "Buli conventions" },
    ])
  } finally {
    await Promise.all([removeWorkspace(workspace), removeWorkspace(home)])
  }
})

test("skips missing user and workspace root instructions", async () => {
  const workspace = await temporaryWorkspace()
  try {
    expect(await loadInstructionFiles(await realpath(workspace), join(workspace, "missing.md"), signal())).toEqual([])
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

      expect(await loadInstructionFiles(await realpath(workspace), userPath, signal())).toEqual([
        { source: userPath, content: "Dotfiles preferences" },
      ])

      await symlink(target, join(workspace, "CLAUDE.md"))
      await expect(
        loadInstructionFiles(await realpath(workspace), userPath, signal()),
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

    expect(await loadInstructionFiles(await realpath(workspace), userPath, signal())).toEqual([
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

    expect(await loadInstructionFiles(await realpath(workspace), userPath, signal())).toEqual([
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

    const files = await loadInstructionFiles(await realpath(workspace), join(home, "0.md"), signal())
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

test("creates the workspace .buli directory when no instructions exist", async () => {
  const workspace = await temporaryWorkspace()
  try {
    const result = await loadBuliInstructions(workspace)

    expect(result).toBeUndefined()
    expect((await stat(join(workspace, ".buli"))).isDirectory()).toBe(true)
  } finally {
    await removeWorkspace(workspace)
  }
})

for (const fileName of ["BULI.md", "AGENTS.md", "CLAUDE.md"] as const) {
  test(`loads .buli/${fileName}`, async () => {
    const workspace = await temporaryWorkspace()
    try {
      await writeInstruction(workspace, fileName, `${fileName} instructions`)

      expect(await loadBuliInstructions(workspace)).toEqual({
        source: `.buli/${fileName}`,
        content: `${fileName} instructions`,
      })
    } finally {
      await removeWorkspace(workspace)
    }
  })
}

test("loads only the highest-priority workspace instruction file", async () => {
  const workspace = await temporaryWorkspace()
  try {
    await Promise.all([
      writeInstruction(workspace, "CLAUDE.md", "Claude instructions"),
      writeInstruction(workspace, "AGENTS.md", "Agent instructions"),
      writeInstruction(workspace, "BULI.md", "Buli instructions"),
    ])

    expect(await loadBuliInstructions(workspace)).toEqual({
      source: ".buli/BULI.md",
      content: "Buli instructions",
    })
  } finally {
    await removeWorkspace(workspace)
  }
})

test("an empty higher-priority file blocks lower-priority files", async () => {
  const workspace = await temporaryWorkspace()
  try {
    await Promise.all([
      writeInstruction(workspace, "BULI.md", ""),
      writeInstruction(workspace, "AGENTS.md", "Agent instructions"),
    ])

    expect(await loadBuliInstructions(workspace)).toEqual({
      source: ".buli/BULI.md",
      content: "",
    })
  } finally {
    await removeWorkspace(workspace)
  }
})

test("ignores singular, unrelated, and incorrectly cased filenames", async () => {
  const workspace = await temporaryWorkspace()
  try {
    await Promise.all([
      writeInstruction(workspace, "AGENT.md", "singular"),
      writeInstruction(workspace, "buli.md", "lowercase"),
      writeInstruction(workspace, "README.md", "unrelated"),
    ])

    expect(await loadBuliInstructions(workspace)).toBeUndefined()
  } finally {
    await removeWorkspace(workspace)
  }
})

test("rejects invalid or oversized selected instructions", async () => {
  const cases: readonly [string, Uint8Array, RegExp][] = [
    ["NUL byte", Uint8Array.from([65, 0, 66]), /contain a NUL byte/],
    ["invalid UTF-8", Uint8Array.from([0xc3, 0x28]), /not valid UTF-8/],
    [
      "oversized content",
      new Uint8Array(INSTRUCTION_FILE_MAX_BYTES + 1).fill(65),
      /exceed 65536 bytes/,
    ],
  ]

  for (const [name, content, expectedError] of cases) {
    const workspace = await temporaryWorkspace(`buli-instructions-${name}-`)
    try {
      await writeInstruction(workspace, "BULI.md", content)

      await expect(
        loadBuliInstructions(workspace),
      ).rejects.toThrow(expectedError)
    } finally {
      await removeWorkspace(workspace)
    }
  }
})

test("rejects a directory selected as an instruction file", async () => {
  const workspace = await temporaryWorkspace()
  try {
    await mkdir(join(workspace, ".buli", "BULI.md"), { recursive: true })

    await expect(
      loadBuliInstructions(workspace),
    ).rejects.toThrow(/Unable to inspect instructions: \.buli\/BULI\.md/)
  } finally {
    await removeWorkspace(workspace)
  }
})

test.skipIf(process.platform === "win32")(
  "allows instruction file symlinks only within the workspace",
  async () => {
    const workspace = await temporaryWorkspace()
    const outside = await temporaryWorkspace("buli-instructions-outside-")
    try {
      const internalTarget = join(workspace, "shared.md")
      await writeFile(internalTarget, "Shared instructions")
      await mkdir(join(workspace, ".buli"), { recursive: true })
      await symlink(internalTarget, join(workspace, ".buli", "AGENTS.md"))

      expect(await loadBuliInstructions(workspace)).toEqual({
        source: ".buli/AGENTS.md",
        content: "Shared instructions",
      })

      await rm(join(workspace, ".buli", "AGENTS.md"))
      const externalTarget = join(outside, "external.md")
      await writeFile(externalTarget, "External instructions")
      await symlink(externalTarget, join(workspace, ".buli", "AGENTS.md"))

      await expect(
        loadBuliInstructions(workspace),
      ).rejects.toThrow(/resolve outside the workspace/)
    } finally {
      await Promise.all([
        removeWorkspace(workspace),
        removeWorkspace(outside),
      ])
    }
  },
)

test.skipIf(process.platform === "win32")(
  "a dangling .buli symlink fails instead of being skipped",
  async () => {
    const workspace = await temporaryWorkspace()
    try {
      await mkdir(join(workspace, ".buli"), { recursive: true })
      await symlink(join(workspace, "deleted.md"), join(workspace, ".buli", "BULI.md"))

      await expect(loadBuliInstructions(workspace)).rejects.toThrow(/Unable to inspect instructions: \.buli\/BULI\.md/)
    } finally {
      await removeWorkspace(workspace)
    }
  },
)

test("does not create .buli when startup is already aborted", async () => {
  const workspace = await temporaryWorkspace()
  const controller = new AbortController()
  const reason = new Error("cancel startup")
  controller.abort(reason)
  try {
    await expect(
      loadInstructionFiles(workspace, join(workspace, "missing-user.md"), controller.signal),
    ).rejects.toBe(reason)
    expect(await readdir(workspace)).toEqual([])
  } finally {
    await removeWorkspace(workspace)
  }
})

/** The `.buli` file alone, or undefined; no user or root instructions exist in these workspaces. */
async function loadBuliInstructions(workspace: string) {
  const files = await loadInstructionFiles(await realpath(workspace), join(workspace, "missing-user.md"), signal())
  if (files.length > 1) throw new Error("Expected at most the .buli instructions")
  return files[0]
}

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
