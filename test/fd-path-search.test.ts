import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createFdPathSearcher } from "@/tools"

test("fd autocomplete finds workspace paths and scopes nested queries", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "buli-fd-workspace-"))
  try {
    await mkdir(join(workspace, "src", "components"), { recursive: true })
    await Promise.all([
      writeFile(join(workspace, "src", "main.ts"), "main"),
      writeFile(join(workspace, "src", "components", "Menu.tsx"), "menu"),
      writeFile(join(workspace, ".hidden.ts"), "hidden"),
      writeFile(join(workspace, "--help"), "dash"),
    ])
    const search = createFdPathSearcher(workspace)

    const main = await search("main", new AbortController().signal)
    expect(main).toContainEqual({
      kind: "file",
      path: await realpath(join(workspace, "src", "main.ts")),
      displayPath: "src/main.ts",
    })

    const nested = await search("src/comp", new AbortController().signal)
    expect(nested).toContainEqual({
      kind: "directory",
      path: await realpath(join(workspace, "src", "components")),
      displayPath: "src/components",
    })

    const hidden = await search("hidden", new AbortController().signal)
    expect(hidden.map((item) => item.displayPath)).toContain(".hidden.ts")

    const dash = await search("--help", new AbortController().signal)
    expect(dash.map((item) => item.displayPath)).toContain("--help")
    const canonicalWorkspace = await realpath(workspace)
    expect(dash.every((item) => item.path.startsWith(canonicalWorkspace))).toBe(true)

    const injected = await search(
      "--search-path=/etc",
      new AbortController().signal,
    )
    expect(injected.every((item) => item.path.startsWith(canonicalWorkspace))).toBe(true)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test("fd autocomplete resolves an explicitly entered external path", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "buli-fd-workspace-"))
  const external = await mkdtemp(join(tmpdir(), "buli-fd-external-"))
  try {
    const externalFile = join(external, "outside file.txt")
    await writeFile(externalFile, "outside")
    const search = createFdPathSearcher(workspace)

    expect(await search(externalFile, new AbortController().signal)).toContainEqual({
      kind: "file",
      path: await realpath(externalFile),
      displayPath: await realpath(externalFile),
    })
  } finally {
    await Promise.all([
      rm(workspace, { recursive: true, force: true }),
      rm(external, { recursive: true, force: true }),
    ])
  }
})

test("fd autocomplete falls back when a legacy update omitted the sidecar", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "buli-fd-fallback-"))
  try {
    await mkdir(join(workspace, "src"))
    await writeFile(join(workspace, "src", "fallback.ts"), "export {}\n")
    const search = createFdPathSearcher(workspace, {
      executablePath: join(workspace, "missing-fd"),
      fallbackWhenMissing: true,
    })

    const results = await search("fallback", new AbortController().signal)
    expect(results.map((item) => item.displayPath)).toContain("src/fallback.ts")
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
