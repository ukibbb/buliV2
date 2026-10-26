import { expect, test } from "bun:test"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { IToolCallContent, IToolResultMessage, IUserMessage } from "@/agent"
import { ClaudeCodeHooks } from "@/integrations/claude-code/hooks"
import { loadClaudeSettings, type THookConfiguration } from "@/integrations/claude-code/settings"

const signal = () => new AbortController().signal

function prompt(content: string): IUserMessage {
  return { id: "u", sessionId: "s", runId: "r", role: "user", source: "prompt", content, createdAt: 1 }
}

function call(toolName: string, input: Record<string, unknown>): IToolCallContent {
  return { type: "toolCall", toolCallId: "c", toolName, input }
}

function result(content: string): IToolResultMessage {
  return {
    id: "t", sessionId: "s", runId: "r", role: "toolResult", assistantMessageId: "a",
    toolCallId: "c", toolName: "write", content, isError: false, createdAt: 2,
  }
}

async function withWorkspace(body: (workspace: string) => Promise<void>) {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "buli-hooks-")))
  try {
    await body(workspace)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}

const command = (script: string, timeoutSeconds?: number) => ({
  hooks: [{ command: script, ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }) }],
})

function sessionHooks(workspace: string, hooks: THookConfiguration) {
  return new ClaudeCodeHooks({ sessionId: "session-1", workspaceRoot: workspace, hooks })
}

test("SessionStart runs once and its plain stdout joins UserPromptSubmit context", async () => {
  await withWorkspace(async (workspace) => {
    const hooks = sessionHooks(workspace, {
      SessionStart: [command("echo session context")],
      UserPromptSubmit: [command("cat > /dev/null; echo prompt context")],
    })

    expect(await hooks.beforePrompt(prompt("first"), signal())).toEqual({
      context: "session context\n\nprompt context",
    })
    expect(await hooks.beforePrompt(prompt("second"), signal())).toEqual({ context: "prompt context" })
  })
})

test("UserPromptSubmit receives Claude Code input and exit 2 blocks with stderr", async () => {
  await withWorkspace(async (workspace) => {
    const inputPath = join(workspace, "input.json")
    const hooks = sessionHooks(workspace, {
      UserPromptSubmit: [command(`cat > "${inputPath}"; echo "no secrets" >&2; exit 2`)],
    })

    expect(await hooks.beforePrompt(prompt("token=abc"), signal())).toEqual({ blockReason: "no secrets" })
    expect(JSON.parse(await readFile(inputPath, "utf8"))).toEqual({
      session_id: "session-1",
      cwd: workspace,
      hook_event_name: "UserPromptSubmit",
      permission_mode: "default",
      prompt: "token=abc",
    })
  })
})

test("PreToolUse matchers see Claude Code tool names and inputs and can deny", async () => {
  await withWorkspace(async (workspace) => {
    const inputPath = join(workspace, "input.json")
    const deny = JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "guarded" },
    })
    const hooks = sessionHooks(workspace, {
      PreToolUse: [
        { matcher: "Bash", ...command("echo never; exit 2") },
        { matcher: "Write|Edit|MultiEdit", ...command(`cat > "${inputPath}"; echo '${deny}'`) },
      ],
    })

    const decision = await hooks.beforeTool(
      call("edit", { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] }),
      signal(),
    )

    expect(decision).toEqual({ blockReason: "guarded" })
    expect(JSON.parse(await readFile(inputPath, "utf8"))).toMatchObject({
      hook_event_name: "PreToolUse",
      tool_name: "MultiEdit",
      tool_input: { file_path: join(workspace, "src/a.ts"), edits: [{ old_string: "a", new_string: "b" }] },
    })
  })
})

test("PostToolUse returns additionalContext and a block reason as model feedback", async () => {
  await withWorkspace(async (workspace) => {
    const output = (body: object) => `echo '${JSON.stringify(body)}'`
    const hooks = sessionHooks(workspace, {
      PostToolUse: [
        command(output({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "ISA synced" } })),
        { matcher: "Write", ...command(output({ decision: "block", reason: "run the tests" })) },
        { matcher: "Bash", ...command(output({ decision: "block", reason: "not for write" })) },
      ],
    })

    const context = await hooks.afterTool(call("write", { path: "a.md", content: "x" }), result("ok"), signal())

    expect(context?.split("\n\n").sort()).toEqual(["ISA synced", "run the tests"])
  })
})

test("an already aborted session starts no hook", async () => {
  await withWorkspace(async (workspace) => {
    const marker = join(workspace, "ran")
    const hooks = sessionHooks(workspace, { PreToolUse: [command(`touch "${marker}"`)] })
    const controller = new AbortController()
    controller.abort()

    expect(await hooks.beforeTool(call("bash", { command: "ls" }), controller.signal)).toEqual({})
    await Bun.sleep(100)
    expect(await Bun.file(marker).exists()).toBe(false)
  })
})

test("failing, plain-output, and timed-out tool hooks do not block", async () => {
  await withWorkspace(async (workspace) => {
    const hooks = sessionHooks(workspace, {
      PreToolUse: [
        command("exit 1"),
        command("echo plain text is ignored for tools"),
        command("sleep 5", 0.2),
      ],
    })

    const started = Date.now()
    expect(await hooks.beforeTool(call("bash", { command: "ls" }), signal())).toEqual({})
    expect(Date.now() - started).toBeLessThan(3000)
  })
})

test("settings keep supported command hooks and the status line", async () => {
  await withWorkspace(async (workspace) => {
    const path = join(workspace, "settings.json")
    await writeFile(path, JSON.stringify({
      model: "ignored",
      env: { BULIOS_MEMORY_ROLE: "client", IGNORED: 1 },
      statusLine: { type: "command", command: "bash status.sh" },
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "guard", timeout: 5 }, { type: "prompt", prompt: "x" }] },
          { matcher: "Agent", hooks: [{ type: "prompt", prompt: "x" }] },
        ],
        Stop: [{ hooks: [{ type: "command", command: "later" }] }],
      },
    }))

    expect(await loadClaudeSettings(path, signal())).toEqual({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "guard", timeoutSeconds: 5 }] }] },
      statusLine: { command: "bash status.sh" },
      env: { BULIOS_MEMORY_ROLE: "client" },
    })
  })
})
