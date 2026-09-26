import { expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createGrepTool } from "@/agent/tools/grep/grep-tool"

test("grep disables external ripgrep configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "buli-grep-policy-"))
    try {
        const executable = join(directory, "fake-rg")
        const captured = join(directory, "arguments.json")
        await writeFile(executable, `#!${process.execPath}\nawait Bun.write(${JSON.stringify(captured)}, JSON.stringify(process.argv.slice(2)))\n`)
        await chmod(executable, 0o700)
        await createGrepTool(directory, executable).validateAndExecute({ pattern: "needle" }, {
            sessionId: "test-session",
            runId: "test-run",
            toolCallId: "test-call",
            signal: new AbortController().signal,
        })
        const args: unknown = JSON.parse(await readFile(captured, "utf8"))
        expect(args).toEqual([
            "--no-config", "--json", "--line-number", "--color=never", "--hidden",
            "--", "needle", directory,
        ])
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})
