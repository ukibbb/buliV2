import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { Type } from "typebox"
import { Value } from "typebox/value"

import type { ISubagentSpec } from "@/agent"
import { claudeDirectory } from "@/integrations/claude-code/instructions"

/** Claude Code tools Buli has, by Claude Code name. */
const BULI_TOOL_NAMES: Readonly<Record<string, string>> = {
    Read: "read",
    Grep: "grep",
    Glob: "find",
    Bash: "bash",
    Edit: "edit",
    MultiEdit: "edit",
    Write: "write",
}

/** A Claude Code agent without a `tools` line may use every tool. */
const ALL_TOOLS = [...new Set(Object.values(BULI_TOOL_NAMES))]

/** The frontmatter fields Buli uses; `tools` is a comma-separated string or a YAML list. */
const AgentFrontmatter = Type.Object({
    name: Type.String({ minLength: 1 }),
    description: Type.String({ minLength: 1 }),
    tools: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
})

/**
 * Reads Claude Code's user agents (`~/.claude/agents/*.md`: YAML frontmatter with `name`, `description`
 * and optional `tools`, then the agent's instructions). An unreadable or invalid file, a repeated name
 * and Claude Code tools Buli does not have are skipped, so one bad file never blocks Buli.
 */
export async function loadClaudeAgents(signal: AbortSignal): Promise<readonly ISubagentSpec[]> {
    const directory = join(claudeDirectory(), "agents")
    let names: string[]
    try {
        names = (await readdir(directory)).filter((name) => name.endsWith(".md")).sort()
    } catch {
        signal.throwIfAborted()
        return []
    }
    const agents = await Promise.all(names.map(async (name) => {
        try {
            return parseAgent(await readFile(join(directory, name), { encoding: "utf8", signal }))
        } catch {
            signal.throwIfAborted()
            return undefined
        }
    }))
    // The first file with a name wins, in file-name order.
    const unique = new Map<string, ISubagentSpec>()
    for (const agent of agents) if (agent && !unique.has(agent.id)) unique.set(agent.id, agent)
    return [...unique.values()]
}

function parseAgent(text: string): ISubagentSpec | undefined {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
    if (!match) return undefined
    const fields: unknown = Bun.YAML.parse(match[1] ?? "")
    const instructions = (match[2] ?? "").trim()
    if (!Value.Check(AgentFrontmatter, fields) || !instructions) return undefined
    const tools = typeof fields.tools === "string" ? fields.tools.split(",") : fields.tools
    const toolNames = tools === undefined
        ? ALL_TOOLS
        : [...new Set(tools.flatMap((tool) => BULI_TOOL_NAMES[tool.trim()] ?? []))]
    return { id: fields.name, description: fields.description, instructions, toolNames }
}
