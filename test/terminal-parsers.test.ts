import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { basename, join } from "node:path"
import { tmpdir } from "node:os"
import { TreeSitterClient } from "@opentui/core"

import {
  registerTerminalParsers,
  terminalParserOptions,
} from "@/terminal/parsers"

const ASSET_CHECKSUMS = {
  "bash-highlights.scm":
    "b74220d954f485b7626d2b2b61f37b522e12eb1830803e388e57dd797dc99f11",
  "tree-sitter-bash.wasm":
    "364f0a2cd385c792239423026ef442dbd073d34c396b7bc9e5932426b8e4aa5d",
  "python-highlights.scm":
    "a6708f209381618e2b398972c8f1ccd892f0c064eab35a2a3f911c3e22e79a7e",
  "tree-sitter-python.wasm":
    "8c93692fb368e288a5824cee55773c9b3602804f513bda48c97661e52e9c2da2",
} as const

const CHECKSUM_MANIFEST = Object.entries(ASSET_CHECKSUMS)
  .map(([file, checksum]) => `${checksum}  ${file}`)
  .join("\n") + "\n"

test("registers verified local Python and Bash parser assets", async () => {
  expect(terminalParserOptions.map(({ filetype, aliases }) => ({
    filetype,
    aliases,
  }))).toEqual([
    { filetype: "python", aliases: ["py", "pyi"] },
    { filetype: "bash", aliases: ["sh", "zsh", "ksh", "shell"] },
  ])

  const assetPaths = terminalParserOptions.flatMap((parser) => [
    parser.wasm,
    ...parser.queries.highlights,
  ])
  expect(assetPaths.map((path) => basename(path)).sort()).toEqual(
    Object.keys(ASSET_CHECKSUMS).sort(),
  )

  for (const path of assetPaths) {
    expect(path).not.toMatch(/^https?:\/\//)
    const content = await readFile(path)
    expect(createHash("sha256").update(content).digest("hex")).toBe(
      ASSET_CHECKSUMS[basename(path) as keyof typeof ASSET_CHECKSUMS],
    )
  }

  const manifest = new URL(
    "../src/terminal/assets/tree-sitter/SHA256SUMS",
    import.meta.url,
  )
  expect(await readFile(manifest, "utf8")).toBe(CHECKSUM_MANIFEST)
})

test("highlights Python and Bash with an empty cache and no network", async () => {
  registerTerminalParsers()
  const dataPath = await mkdtemp(join(tmpdir(), "buli-tree-sitter-"))
  const client = new TreeSitterClient({ dataPath })
  const originalFetch = globalThis.fetch
  globalThis.fetch = Object.assign(
    () => Promise.reject(new Error("Network disabled in test")),
    { preconnect: () => undefined },
  )

  try {
    const python = await client.highlightOnce(
      "def greet(name):\n    return f\"Hello, {name}\"\n",
      "python",
    )
    expect(python.error).toBeUndefined()
    expect(python.warning).toBeUndefined()
    expect(python.highlights?.some((highlight) =>
      highlight[2] === "function"
    )).toBe(true)

    const bash = await client.highlightOnce(
      "#!/usr/bin/env bash\nname=world\necho \"Hello, $name\"\n",
      "bash",
    )
    expect(bash.error).toBeUndefined()
    expect(bash.warning).toBeUndefined()
    expect(bash.highlights?.some((highlight) =>
      highlight[2] === "function"
    )).toBe(true)

    const shellAlias = await client.highlightOnce("echo offline\n", "shell")
    expect(shellAlias.error).toBeUndefined()
    expect(shellAlias.highlights?.length).toBeGreaterThan(0)

    const cachePath = join(dataPath, "tree-sitter")
    expect(await readdir(join(cachePath, "languages"))).toEqual([])
    expect(await readdir(join(cachePath, "queries"))).toEqual([])
  } finally {
    globalThis.fetch = originalFetch
    await client.destroy()
    await rm(dataPath, { recursive: true, force: true })
  }
})
