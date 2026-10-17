import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FilePromptCommands } from "../prompt-commands"

test("global prompts round-trip, survive reopening, reject collisions and delete", () => {
    const directory = mkdtempSync(join(tmpdir(), "buli-commands-"))
    try {
        const commands = new FilePromptCommands(join(directory, "commands"))
        expect(commands.list()).toEqual([])
        commands.add({ name: "review", prompt: "Review code.\nExplain errors." })
        expect(readFileSync(join(directory, "commands/review.md"), "utf8")).toBe("Review code.\nExplain errors.")
        const reopened = new FilePromptCommands(join(directory, "commands"))
        expect(reopened.list()).toEqual([{ name: "review", prompt: "Review code.\nExplain errors." }])
        expect(() => reopened.add({ name: "review", prompt: "replacement" })).toThrow("already exists")
        expect(commands.list()[0]?.prompt).toBe("Review code.\nExplain errors.")
        commands.remove("review")
        expect(reopened.list()).toEqual([])
        commands.remove("review")
    } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("invalid names and empty prompts cannot write outside the command directory", () => {
    const commands = new FilePromptCommands("/unused")
    for (const name of ["../escape", "", "/review", "Two Words", "UPPER", "a/b", "a".repeat(65)]) {
        expect(() => commands.add({ name, prompt: "prompt" })).toThrow()
        expect(() => commands.remove(name)).toThrow()
    }
    expect(() => commands.add({ name: "review", prompt: " \n " })).toThrow("empty")
})
