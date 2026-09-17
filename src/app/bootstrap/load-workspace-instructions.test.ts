import { expect, test } from "bun:test"
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  loadWorkspaceInstructions,
  WORKSPACE_INSTRUCTIONS_MAX_BYTES,
} from "@/app/bootstrap/load-workspace-instructions"

test("creates the workspace .buli directory when no instructions exist", async () => {
  const workspace = await temporaryWorkspace()
  try {
    const result = await loadWorkspaceInstructions(workspace, signal())

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

      expect(await loadWorkspaceInstructions(workspace, signal())).toEqual({
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

    expect(await loadWorkspaceInstructions(workspace, signal())).toEqual({
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

    expect(await loadWorkspaceInstructions(workspace, signal())).toEqual({
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

    expect(await loadWorkspaceInstructions(workspace, signal())).toBeUndefined()
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
      new Uint8Array(WORKSPACE_INSTRUCTIONS_MAX_BYTES + 1).fill(65),
      /exceed 65536 bytes/,
    ],
  ]

  for (const [name, content, expectedError] of cases) {
    const workspace = await temporaryWorkspace(`buli-instructions-${name}-`)
    try {
      await writeInstruction(workspace, "BULI.md", content)

      await expect(
        loadWorkspaceInstructions(workspace, signal()),
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
      loadWorkspaceInstructions(workspace, signal()),
    ).rejects.toThrow(/Unable to inspect workspace instructions: \.buli\/BULI\.md/)
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

      expect(await loadWorkspaceInstructions(workspace, signal())).toEqual({
        source: ".buli/AGENTS.md",
        content: "Shared instructions",
      })

      await rm(join(workspace, ".buli", "AGENTS.md"))
      const externalTarget = join(outside, "external.md")
      await writeFile(externalTarget, "External instructions")
      await symlink(externalTarget, join(workspace, ".buli", "AGENTS.md"))

      await expect(
        loadWorkspaceInstructions(workspace, signal()),
      ).rejects.toThrow(/resolve outside the workspace/)
    } finally {
      await Promise.all([
        removeWorkspace(workspace),
        removeWorkspace(outside),
      ])
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
      loadWorkspaceInstructions(workspace, controller.signal),
    ).rejects.toBe(reason)
    expect(await readdir(workspace)).toEqual([])
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
