import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface IUserPromptCommand {
    readonly name: string
    readonly prompt: string
}

export interface IUserPromptCommands {
    readonly list: () => readonly IUserPromptCommand[]
    readonly add: (command: IUserPromptCommand) => void
    readonly remove: (name: string) => void
}

const COMMAND_NAME = /^[a-z][a-z0-9-]{0,63}$/

/** Global user prompts, stored as one Markdown file per command. */
export class FilePromptCommands implements IUserPromptCommands {
    constructor(private readonly directory = join(homedir(), ".buli", "commands")) {}

    readonly list = (): readonly IUserPromptCommand[] => {
        let names: string[]
        try {
            names = readdirSync(this.directory)
        } catch (error) {
            if (hasCode(error, "ENOENT")) return []
            throw error
        }
        return names.filter(name => name.endsWith(".md") && COMMAND_NAME.test(name.slice(0, -3)))
            .sort().map(file => ({ name: file.slice(0, -3), prompt: readFileSync(join(this.directory, file), "utf8") }))
            .filter(command => command.prompt.trim().length > 0)
    }

    readonly add = ({ name, prompt }: IUserPromptCommand): void => {
        assertName(name)
        if (!prompt.trim()) throw new Error("Prompt must not be empty")
        mkdirSync(this.directory, { recursive: true })
        const path = join(this.directory, `${name}.md`)
        let descriptor: number
        try {
            descriptor = openSync(path, "wx", 0o600)
        } catch (error) {
            if (hasCode(error, "EEXIST")) throw new Error(`Command /${name} already exists`)
            throw error
        }
        try {
            writeFileSync(descriptor, prompt, "utf8")
        } catch (error) {
            try { unlinkSync(path) } catch { /* Preserve the write error. */ }
            throw error
        } finally {
            closeSync(descriptor)
        }
    }

    readonly remove = (name: string): void => {
        assertName(name)
        try { unlinkSync(join(this.directory, `${name}.md`)) } catch (error) {
            if (!hasCode(error, "ENOENT")) throw error
        }
    }
}

function assertName(name: string): void {
    if (!COMMAND_NAME.test(name)) throw new Error("Use 1–64 lowercase letters, digits or hyphens; start with a letter")
}

function hasCode(error: unknown, code: string): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === code
}
