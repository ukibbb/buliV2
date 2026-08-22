import { expect, test } from "bun:test"
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  prepareWorkspacePatch,
  StaleWorkspacePatchError,
  WORKSPACE_PATCH_MAX_AGGREGATE_BYTES,
  WORKSPACE_PATCH_MAX_DIFF_BYTES,
  WORKSPACE_PATCH_MAX_OPERATIONS,
  WORKSPACE_PATCH_MAX_PATCH_BYTES,
  WORKSPACE_PATCH_MAX_SOURCE_BYTES,
  type IPreparedWorkspacePatch,
} from "@/tools/patch/patch-engine"

test("plans and applies add, update, delete, and move as exact file states", async () => {
  const workspace = await temporaryWorkspace()
  try {
    await writeFile(join(workspace, "update.txt"), "alpha\nbeta\n")
    await writeFile(join(workspace, "delete.txt"), "remove me\n")
    await writeFile(join(workspace, "move.txt"), "old location\n")

    const proposal = await plan(workspace, `*** Add File: nested/added.txt
+added
+file
*** Update File: update.txt
@@
-beta
+BETA
*** Delete File: delete.txt
*** Update File: move.txt
*** Move to: moved/renamed.txt
@@
-old location
+new location`)

    expect(await readFile(join(workspace, "update.txt"), "utf8")).toBe("alpha\nbeta\n")
    expect(Object.isFrozen(proposal)).toBe(true)
    expect(Object.isFrozen(proposal.preview)).toBe(true)
    expect(Object.isFrozen(proposal.preview.summary)).toBe(true)
    expect(Object.isFrozen(proposal.preview.affectedPaths)).toBe(true)
    expect(Object.keys(proposal.preview).sort()).toEqual(["affectedPaths", "diff", "summary"])
    expect(proposal.preview.affectedPaths).toEqual([
      "nested/added.txt",
      "update.txt",
      "delete.txt",
      "move.txt",
      "moved/renamed.txt",
    ])
    expect(proposal.preview.summary.filesChanged).toBe(4)
    expect(proposal.preview.diff).toContain("--- /dev/null\n+++ b/nested/added.txt")
    expect(proposal.preview.diff).toContain("--- a/move.txt\n+++ b/moved/renamed.txt")
    expect(proposal.preview.diff).toContain("-beta\n+BETA")

    const result = await proposal.applyOnce(signal())

    expect(result.applied).toBe(true)
    expect(result.filesChanged).toBe(4)
    expect(await readFile(join(workspace, "nested", "added.txt"), "utf8")).toBe(
      "added\nfile\n",
    )
    expect(await readFile(join(workspace, "update.txt"), "utf8")).toBe("alpha\nBETA\n")
    expect(await pathExists(join(workspace, "delete.txt"))).toBe(false)
    expect(await pathExists(join(workspace, "move.txt"))).toBe(false)
    expect(await readFile(join(workspace, "moved", "renamed.txt"), "utf8")).toBe(
      "new location\n",
    )
    await expect(proposal.applyOnce(signal())).rejects.toThrow(/no longer available/i)
  } finally {
    await removeWorkspace(workspace)
  }
})

test("discard makes an in-memory proposal permanently unavailable", async () => {
  const workspace = await temporaryWorkspace()
  try {
    const proposal = await plan(workspace, "*** Add File: discarded.txt\n+content")
    proposal.discard()

    await expect(proposal.applyOnce(signal())).rejects.toThrow(/no longer available/i)
    expect(await readdir(workspace)).toEqual([])
  } finally {
    await removeWorkspace(workspace)
  }
})

test("enforces patch, operation, aggregate-content, and rendered-diff limits", async () => {
  const workspace = await temporaryWorkspace()
  try {
    const oversizedUtf8 = "é".repeat(Math.floor(WORKSPACE_PATCH_MAX_PATCH_BYTES / 2) + 1)
    await expect(prepareWorkspacePatch({
      patchText: oversizedUtf8,
      workspaceRoot: workspace,
      signal: signal(),
    })).rejects.toThrow(/patch text.*500 KiB limit/i)

    const tooManyOperations = Array.from(
      { length: WORKSPACE_PATCH_MAX_OPERATIONS + 1 },
      (_, index) => `*** Add File: operation-${index}.txt\n+content`,
    ).join("\n")
    await expect(plan(workspace, tooManyOperations)).rejects.toThrow(/50 operations/i)

    const tooManyPatchLines = [
      "*** Add File: too-many-lines.txt",
      ...Array.from({ length: 50_000 }, () => "+"),
    ].join("\n")
    await expect(plan(workspace, tooManyPatchLines)).rejects.toThrow(/50000 lines/i)

    await writeFile(join(workspace, "too-many-source-lines.txt"), "x\n".repeat(100_001))
    await expect(plan(workspace, `*** Update File: too-many-source-lines.txt
@@
-x
+changed`)).rejects.toThrow(/more than 100000 lines/i)

    const largeLine = "x".repeat(Math.floor(WORKSPACE_PATCH_MAX_AGGREGATE_BYTES / 6) + 1)
    const aggregateHunks: string[] = []
    for (let index = 0; index < 3; index += 1) {
      await writeFile(join(workspace, `aggregate-${index}.txt`), `${largeLine}\nold-${index}\n`)
      aggregateHunks.push(`*** Update File: aggregate-${index}.txt
@@
-old-${index}
+new-${index}`)
    }
    await expect(plan(workspace, aggregateHunks.join("\n")))
      .rejects.toThrow(/4 MiB aggregate limit/i)

    const contextWidth = Math.floor(WORKSPACE_PATCH_MAX_DIFF_BYTES / 6) + 1024
    const contextLines = Array.from(
      { length: 6 },
      (_, index) => `${index}-${"y".repeat(contextWidth)}`,
    )
    const diffSource = [
      ...contextLines.slice(0, 3),
      "old",
      ...contextLines.slice(3),
    ].join("\n") + "\n"
    await writeFile(join(workspace, "large-diff.txt"), diffSource)
    await expect(plan(workspace, `*** Update File: large-diff.txt
@@
-old
+new`)).rejects.toThrow(/approval diff.*500 KiB limit/i)
    expect(await readFile(join(workspace, "large-diff.txt"), "utf8")).toBe(diffSource)
  } finally {
    await removeWorkspace(workspace)
  }
})

test("rejects malformed envelopes, hunks, numeric anchors, and no-op chunks", async () => {
  const workspace = await temporaryWorkspace()
  try {
    await writeFile(join(workspace, "file.txt"), "old\n")
    const malformed = [
      "*** Add File: added.txt\n+x\n*** End Patch",
      "*** Begin Patch\n*** Add File: added.txt\n+x",
      patchText("*** Add File: added.txt"),
      patchText("*** Update File: file.txt"),
      patchText("*** Update File: file.txt\n@@ -1,1 +1,1 @@\n-old\n+new"),
      patchText("*** Update File: file.txt\n@@\n old"),
      patchText("*** Update File: file.txt\n@@\n-old\n+old"),
      patchText(""),
    ]

    for (const patch of malformed) {
      await expect(prepareWorkspacePatch({
        patchText: patch,
        workspaceRoot: workspace,
        signal: signal(),
      })).rejects.toThrow()
    }
    expect(await readdir(workspace)).toEqual(["file.txt"])
  } finally {
    await removeWorkspace(workspace)
  }
})

test("uses exact context, rejects ambiguity and whitespace mismatch, and honors anchors", async () => {
  const workspace = await temporaryWorkspace()
  try {
    await writeFile(
      join(workspace, "repeated.txt"),
      "section one\nneedle\nsection two\nneedle\n",
    )

    await expect(plan(workspace, `*** Update File: repeated.txt
@@
-needle
+changed`)).rejects.toThrow(/ambiguous/i)

    await expect(plan(workspace, `*** Update File: repeated.txt
@@
- needle
+changed`)).rejects.toThrow(/exact context/i)

    const anchored = await plan(workspace, `*** Update File: repeated.txt
@@ section two
-needle
+changed`)
    await anchored.applyOnce(signal())
    expect(await readFile(join(workspace, "repeated.txt"), "utf8")).toBe(
      "section one\nneedle\nsection two\nchanged\n",
    )

    const multipleChunks = await plan(workspace, `*** Update File: repeated.txt
@@ section one
-needle
+first changed
@@ section two
-changed
+second changed
*** End of File`)
    await multipleChunks.applyOnce(signal())
    expect(await readFile(join(workspace, "repeated.txt"), "utf8")).toBe(
      "section one\nfirst changed\nsection two\nsecond changed\n",
    )
  } finally {
    await removeWorkspace(workspace)
  }
})

test("preserves a UTF-8 BOM, dominant CRLF endings, and update mode", async () => {
  const workspace = await temporaryWorkspace()
  const file = join(workspace, "windows.txt")
  try {
    const bom = Buffer.from([0xef, 0xbb, 0xbf])
    await writeFile(file, Buffer.concat([bom, Buffer.from("first\r\nsecond\r\n")]))
    await chmod(file, 0o640)

    const patch = await plan(workspace, `*** Update File: windows.txt
@@ first
-second
+changed`)
    await patch.applyOnce(signal())

    expect(await readFile(file)).toEqual(
      Buffer.concat([bom, Buffer.from("first\r\nchanged\r\n")]),
    )
    expect((await stat(file)).mode & 0o777).toBe(0o640)
  } finally {
    await removeWorkspace(workspace)
  }
})

test("preserves the replaced line ending in a mixed-EOL file", async () => {
  const workspace = await temporaryWorkspace()
  const file = join(workspace, "mixed-eol.txt")
  try {
    await writeFile(file, "one\r\nmixed\nthree\r\n")

    const patch = await plan(workspace, `*** Update File: mixed-eol.txt
@@ one
-mixed
+changed`)
    await patch.applyOnce(signal())

    expect(await readFile(file, "utf8")).toBe("one\r\nchanged\nthree\r\n")
  } finally {
    await removeWorkspace(workspace)
  }
})

test("rejects empty, traversal, absolute, Windows, NUL, and .git paths", async () => {
  const workspace = await temporaryWorkspace()
  try {
    const invalidPaths = [
      "",
      "../outside.txt",
      "nested/../../outside.txt",
      "/tmp/outside.txt",
      "C:\\outside.txt",
      "\\\\server\\share\\outside.txt",
      "bad\0name.txt",
      ".git/config",
      "nested/.git/index",
    ]
    for (const path of invalidPaths) {
      await expect(plan(workspace, `*** Add File: ${path}\n+blocked`)).rejects.toThrow()
    }
    expect(await readdir(workspace)).toEqual([])
  } finally {
    await removeWorkspace(workspace)
  }
})

test("canonicalizes safe symlinks and rejects existing and missing symlink escapes", async () => {
  const workspace = await temporaryWorkspace()
  const outside = await temporaryWorkspace("buli-patch-outside-")
  try {
    const actual = join(workspace, "actual.txt")
    const outsideFile = join(outside, "outside.txt")
    await writeFile(actual, "before\n")
    await writeFile(outsideFile, "outside\n")
    await symlink(actual, join(workspace, "inside-link.txt"))
    await symlink(outsideFile, join(workspace, "outside-link.txt"))
    await symlink(outside, join(workspace, "outside-directory"))

    const safePlan = await plan(workspace, `*** Update File: inside-link.txt
@@
-before
+after`)
    expect(safePlan.preview.affectedPaths).toEqual(["actual.txt"])
    await safePlan.applyOnce(signal())
    expect(await readFile(actual, "utf8")).toBe("after\n")
    expect((await lstat(join(workspace, "inside-link.txt"))).isSymbolicLink()).toBe(true)

    await expect(plan(workspace, `*** Update File: outside-link.txt
@@
-outside
+escaped`)).rejects.toThrow(/outside the workspace/i)
    await expect(plan(workspace, "*** Add File: outside-directory/new.txt\n+escaped"))
      .rejects.toThrow(/outside the workspace/i)
    expect(await pathExists(join(outside, "new.txt"))).toBe(false)
  } finally {
    await Promise.all([removeWorkspace(workspace), removeWorkspace(outside)])
  }
})

test("rejects binary, invalid UTF-8, oversized sources, and binary additions", async () => {
  const workspace = await temporaryWorkspace()
  try {
    await writeFile(join(workspace, "binary.dat"), Buffer.from([0x61, 0x00, 0x62]))
    await writeFile(join(workspace, "invalid.txt"), Buffer.from([0xff, 0xfe]))
    await writeFile(
      join(workspace, "large.txt"),
      Buffer.alloc(WORKSPACE_PATCH_MAX_SOURCE_BYTES + 1, 0x61),
    )

    await expect(plan(workspace, "*** Delete File: binary.dat")).rejects.toThrow(/binary/i)
    await expect(plan(workspace, "*** Delete File: invalid.txt")).rejects.toThrow(/UTF-8/i)
    await expect(plan(workspace, "*** Delete File: large.txt")).rejects.toThrow(/exceeds/i)
    await expect(plan(workspace, "*** Add File: binary-new.txt\n+bad\0data"))
      .rejects.toThrow(/binary/i)
  } finally {
    await removeWorkspace(workspace)
  }
})

test("rejects stale proposals before mutating any target", async () => {
  const workspace = await temporaryWorkspace()
  try {
    const file = join(workspace, "file.txt")
    await writeFile(file, "before\n")
    const patch = await plan(workspace, `*** Update File: file.txt
@@
-before
+after`)
    await writeFile(file, "changed externally\n")

    await expect(patch.applyOnce(signal()))
      .rejects.toBeInstanceOf(StaleWorkspacePatchError)
    expect(await readFile(file, "utf8")).toBe("changed externally\n")
  } finally {
    await removeWorkspace(workspace)
  }
})

test("rejects add and move destinations created after planning without overwriting", async () => {
  const workspace = await temporaryWorkspace()
  try {
    const addPlan = await plan(workspace, "*** Add File: claimed.txt\n+planned")
    await writeFile(join(workspace, "claimed.txt"), "external\n")
    await expect(addPlan.applyOnce(signal()))
      .rejects.toBeInstanceOf(StaleWorkspacePatchError)
    expect(await readFile(join(workspace, "claimed.txt"), "utf8")).toBe("external\n")

    await writeFile(join(workspace, "source.txt"), "before\n")
    const movePlan = await plan(workspace, `*** Update File: source.txt
*** Move to: destination.txt
@@
-before
+after`)
    await writeFile(join(workspace, "destination.txt"), "external destination\n")
    await expect(movePlan.applyOnce(signal()))
      .rejects.toBeInstanceOf(StaleWorkspacePatchError)
    expect(await readFile(join(workspace, "source.txt"), "utf8")).toBe("before\n")
    expect(await readFile(join(workspace, "destination.txt"), "utf8")).toBe(
      "external destination\n",
    )
  } finally {
    await removeWorkspace(workspace)
  }
})

test("aborts before commit without creating files or directories", async () => {
  const workspace = await temporaryWorkspace()
  try {
    const patch = await plan(workspace, "*** Add File: nested/new.txt\n+content")
    const controller = new AbortController()
    controller.abort(new DOMException("Stopped before commit", "AbortError"))

    await expect(patch.applyOnce(controller.signal))
      .rejects.toMatchObject({ name: "AbortError", message: "Stopped before commit" })
    expect(await readdir(workspace)).toEqual([])
  } finally {
    await removeWorkspace(workspace)
  }
})

test("preflights every file and never partially mutates when a later hunk fails", async () => {
  const workspace = await temporaryWorkspace()
  try {
    await writeFile(join(workspace, "existing.txt"), "original\n")
    await expect(plan(workspace, `*** Add File: would-be-added.txt
+new
*** Update File: existing.txt
@@
-missing context
+replacement`)).rejects.toThrow(/exact context/i)

    expect(await pathExists(join(workspace, "would-be-added.txt"))).toBe(false)
    expect(await readFile(join(workspace, "existing.txt"), "utf8")).toBe("original\n")
  } finally {
    await removeWorkspace(workspace)
  }
})

test("rejects add-existing, missing sources, move-existing, and path conflicts", async () => {
  const workspace = await temporaryWorkspace()
  try {
    await writeFile(join(workspace, "source.txt"), "source\n")
    await writeFile(join(workspace, "destination.txt"), "destination\n")

    await expect(plan(workspace, "*** Add File: source.txt\n+new"))
      .rejects.toThrow(/existing/i)
    await expect(plan(workspace, `*** Update File: missing.txt
@@
-old
+new`)).rejects.toThrow(/does not exist/i)
    await expect(plan(workspace, `*** Update File: source.txt
*** Move to: destination.txt
@@
-source
+moved`)).rejects.toThrow(/destination already exists/i)
    await expect(plan(workspace, `*** Delete File: source.txt
*** Delete File: source.txt`)).rejects.toThrow(/conflicting/i)
    if (process.platform === "darwin" || process.platform === "win32") {
      await expect(plan(workspace, `*** Add File: Case.txt
+first
*** Add File: case.txt
+second`)).rejects.toThrow(/conflicting/i)
    }
    await expect(plan(workspace, `*** Add File: parent
+file
*** Add File: parent/child.txt
+child`)).rejects.toThrow(/conflicting/i)

    expect(await readFile(join(workspace, "source.txt"), "utf8")).toBe("source\n")
    expect(await readFile(join(workspace, "destination.txt"), "utf8")).toBe(
      "destination\n",
    )
  } finally {
    await removeWorkspace(workspace)
  }
})

test("rolls back committed writes when a later move-source deletion fails", async () => {
  if (typeof process.getuid === "function" && process.getuid() === 0) return

  const workspace = await temporaryWorkspace()
  const lockedDirectory = join(workspace, "locked")
  try {
    await mkdir(lockedDirectory)
    const source = join(lockedDirectory, "source.txt")
    const destination = join(workspace, "rolled-back", "moved.txt")
    await writeFile(source, "before\n")
    const patch = await plan(workspace, `*** Update File: locked/source.txt
*** Move to: rolled-back/moved.txt
@@
-before
+after`)
    await chmod(lockedDirectory, 0o555)

    await expect(patch.applyOnce(signal()))
      .rejects.toThrow(/rolled back/i)

    expect(await readFile(source, "utf8")).toBe("before\n")
    expect(await pathExists(destination)).toBe(false)
    expect(await pathExists(join(workspace, "rolled-back"))).toBe(false)
  } finally {
    await chmod(lockedDirectory, 0o755).catch(() => {})
    await removeWorkspace(workspace)
  }
})

async function plan(
  workspaceRoot: string,
  body: string,
  abortSignal: AbortSignal = signal(),
): Promise<IPreparedWorkspacePatch> {
  return await prepareWorkspacePatch({
    patchText: patchText(body),
    workspaceRoot,
    signal: abortSignal,
  })
}

function patchText(body: string): string {
  return `*** Begin Patch\n${body}\n*** End Patch`
}

function signal(): AbortSignal {
  return new AbortController().signal
}

async function temporaryWorkspace(prefix = "buli-patch-"): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix))
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
