import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { loadClaudeAgents } from "@/integrations/claude-code/agents"

async function withHome(body: (home: string) => Promise<void>) {
    const home = await mkdtemp(join(tmpdir(), "buli-agents-"))
    const realHome = process.env.HOME
    process.env.HOME = home
    try {
        await body(home)
    } finally {
        process.env.HOME = realHome
        await rm(home, { recursive: true, force: true })
    }
}

test("reads ~/.claude/agents with Claude Code tools mapped to Buli's and unknown tools dropped", async () => {
    await withHome(async (home) => {
        const agents = join(home, ".claude", "agents")
        await mkdir(agents, { recursive: true })
        await writeFile(join(agents, "reviewer.md"), "---\nname: reviewer\ndescription: \"Review a diff\"\ntools: Read, Grep, Glob, Bash, WebFetch\n---\n\nYou review code.\n")
        await writeFile(join(agents, "helper.md"), "---\nname: helper\ndescription: Does anything\n---\nHelp.")
        await writeFile(join(agents, "broken.md"), "---\nname: broken\n---\nNo description.")
        await writeFile(join(agents, "notes.txt"), "not an agent")
        await writeFile(join(agents, "listed.md"), "---\nname: listed\ndescription: >\n  Folded\n  description\ntools:\n  - Read\n  - Write\n---\nList tools.")
        await writeFile(join(agents, "invalid.md"), "---\nname: [unclosed\n---\nBad YAML.")
        await writeFile(join(agents, "zz-duplicate.md"), "---\nname: reviewer\ndescription: Second reviewer\n---\nIgnored.")

        expect(await loadClaudeAgents(new AbortController().signal)).toEqual([
            { id: "helper", description: "Does anything", instructions: "Help.", toolNames: ["read", "grep", "find", "bash", "edit", "write"] },
            { id: "listed", description: "Folded description\n", instructions: "List tools.", toolNames: ["read", "write"] },
            { id: "reviewer", description: "Review a diff", instructions: "You review code.", toolNames: ["read", "grep", "find", "bash"] },
        ])
    })
})

test("no agents directory means no agents", async () => {
    await withHome(async () => {
        expect(await loadClaudeAgents(new AbortController().signal)).toEqual([])
    })
})
