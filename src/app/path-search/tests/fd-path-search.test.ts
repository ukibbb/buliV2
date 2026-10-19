import { expect, spyOn, test } from "bun:test"
import * as fs from "node:fs/promises"
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createFdPathSearcher } from "@/app/path-search/fd-path-search"

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

test("fd candidates reuse direct metadata and deduplicate raw and canonical paths before stat", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "buli-fd-dedup-"))
  let realpathSpy: ReturnType<typeof spyOn<typeof fs, "realpath">> | undefined
  let statSpy: ReturnType<typeof spyOn<typeof fs, "stat">> | undefined
  try {
    const file = join(workspace, "target.ts")
    const alias = join(workspace, "alias.ts")
    await writeFile(file, "target")
    await symlink(file, alias)
    const executable = join(workspace, "fake-fd")
    const candidates = [file, file, alias, alias, join(workspace, "missing.ts")]
    await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(candidates.join("\0") + "\0")})\n`)
    await chmod(executable, 0o755)
    const canonicalFile = await realpath(file)
    const originalRealpath = fs.realpath
    realpathSpy = spyOn(fs, "realpath")
    statSpy = spyOn(fs, "stat")
    const search = createFdPathSearcher(workspace, { executablePath: executable })
    const results = await search("target.ts", new AbortController().signal)
    expect(results).toEqual([{ kind: "file", path: canonicalFile, displayPath: "target.ts" }])
    expect(realpathSpy.mock.calls.filter(([path]) => path === file)).toHaveLength(1)
    expect(realpathSpy.mock.calls.filter(([path]) => path === alias)).toHaveLength(1)
    expect(statSpy.mock.calls.filter(([path]) => path === canonicalFile)).toHaveLength(1)
    realpathSpy.mockRestore()
    const controller = new AbortController()
    realpathSpy = spyOn(fs, "realpath").mockImplementation(new Proxy(originalRealpath, {
      apply(target, thisArg, args) {
        if (args[0] === alias) controller.abort()
        return Reflect.apply(target, thisArg, args)
      },
    }))
    await expect(search("", controller.signal)).rejects.toThrow()
  } finally {
    realpathSpy?.mockRestore()
    statSpy?.mockRestore()
    await rm(workspace, { recursive: true, force: true })
  }
})

test("fallback reuses discovered metadata and preserves canonical deduplication, ranking and result limit", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "buli-fd-metadata-"))
  let statSpy: ReturnType<typeof spyOn<typeof fs, "stat">> | undefined
  try {
    await mkdir(join(workspace, "target-dir"))
    await Promise.all(Array.from({ length: 40 }, (_, index) => writeFile(join(workspace, `target-${String(index).padStart(2, "0")}.ts`), "target")))
    const target = join(workspace, "target-00.ts")
    const canonicalTarget = await realpath(target)
    await symlink(target, join(workspace, "alias.ts"))
    statSpy = spyOn(fs, "stat")
    const search = createFdPathSearcher(workspace, {
      executablePath: join(workspace, "missing-fd"), fallbackWhenMissing: true,
    })
    const results = await search("target", new AbortController().signal)
    expect(results).toHaveLength(30)
    expect(results[0]?.displayPath).toBe("target-dir")
    expect(results.slice(1).map((item) => item.displayPath)).toEqual(
      Array.from({ length: 29 }, (_, index) => `target-${String(index).padStart(2, "0")}.ts`),
    )
    // The file and its symlink are each inspected during discovery, not again during ranking.
    expect(statSpy.mock.calls.filter(([path]) => path === canonicalTarget)).toHaveLength(2)
    expect(new Set(results.map((item) => item.path)).size).toBe(results.length)
    const controller = new AbortController()
    controller.abort()
    await expect(search("target", controller.signal)).rejects.toThrow()
  } finally {
    statSpy?.mockRestore()
    await rm(workspace, { recursive: true, force: true })
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
