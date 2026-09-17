import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TreeSitterClient } from "@opentui/core"

import {
    registerTerminalParsers,
    terminalParserOptions,
} from "../src/ui/terminal/parsers"

// Compile this entrypoint to exercise Bun's embedded asset paths and worker.
// Optional arguments verify that the actual application binaries contain the
// same WASM/query bytes as the compiled probe.
const assets = await Promise.all(terminalParserOptions.flatMap((parser) => [
    parser.wasm, ...parser.queries.highlights,
]).map(async (path) => ({ path, bytes: await readFile(path) })))
for (const executable of process.argv.slice(2)) {
    const binary = await readFile(executable)
    for (const asset of assets) {
        assert(binary.includes(asset.bytes), `${executable}: missing ${asset.path}`)
    }
    console.log(`${executable}: all four Bash/Python assets embedded`)
}

registerTerminalParsers()
const dataPath = await mkdtemp(join(tmpdir(), "buli-parser-smoke-"))
const client = new TreeSitterClient({ dataPath })
const originalFetch = globalThis.fetch
globalThis.fetch = Object.assign(
    () => Promise.reject(new Error("Network disabled in parser smoke test")),
    { preconnect: () => undefined },
)
try {
    for (const [language, code] of [
        ["python", "def greet(name):\n    return f'Hello, {name}'\n"],
        ["bash", "#!/usr/bin/env bash\nname=world\necho \"Hello, $name\"\n"],
        ["shell", "echo offline\n"],
    ] as const) {
        const result = await client.highlightOnce(code, language)
        assert.equal(result.error, undefined)
        assert.equal(result.warning, undefined)
        assert(result.highlights)
        assert(result.highlights.some((highlight) => highlight[2] === "function"))
        console.log(`${language}: highlighting OK (${result.highlights.length} captures)`)
    }
    for (const directory of ["languages", "queries"]) {
        assert.deepEqual(await readdir(join(dataPath, "tree-sitter", directory)), [])
    }
    console.log("Parser smoke test passed with a fresh, unpopulated parser cache")
} finally {
    globalThis.fetch = originalFetch
    await client.destroy()
    await rm(dataPath, { recursive: true, force: true })
}
