import { expect, test } from "bun:test"

import { systemPrompt } from "@/agent/system-prompt"
import type { IAgentToolDescriptor } from "@/agent/tool"

const descriptor = (name: string): IAgentToolDescriptor => ({
  name,
  description: `${name} description`,
  inputSchema: { type: "object" },
})

test("builds proposal instructions from complete active capabilities", () => {
  const prompt = systemPrompt("/workspace", [
    descriptor("read"),
    descriptor("find"),
    descriptor("grep"),
    descriptor("edit"),
    descriptor("write"),
    descriptor("apply_file_changes"),
    descriptor("reject_file_changes"),
    descriptor("bash"),
    descriptor("tool_output"),
  ])

  expect(prompt).toContain(
    "Active tools: read, find, grep, edit, write, apply_file_changes, reject_file_changes, bash, tool_output.",
  )
  for (const sectionName of [
    "general",
    "intent_routing",
    "problem_solving",
    "learning",
    "planning",
    "implementation",
    "code_explanation",
  ]) {
    expect(prompt).toContain(`<${sectionName}>`)
    expect(prompt).toContain(`</${sectionName}>`)
  }
  expect(prompt).toContain("You are not an autonomous executor")
  expect(prompt).toContain("the user retains ownership of the code")
  expect(prompt).toContain("generate an immutable proposal")
  expect(prompt).toContain("do not modify workspace files")
  expect(prompt).toContain("using apply_file_changes with its proposal ID")
  expect(prompt).toContain("call reject_file_changes")
  expect(prompt).toContain("Copy every edits[].oldText")
  expect(prompt).toContain("Use write only for new files")
  expect(prompt).toContain("Before every Bash call")
  expect(prompt).toContain("/bin/bash --noprofile --norc")
  expect(prompt).toContain("encoding=base64")
  expect(prompt).toContain("increase the limit or narrow the pattern or path")
  expect(prompt).not.toContain("modify workspace files directly")
  expect(prompt).not.toContain("<workspace_instructions")
})

test("describes direct mutation when proposal tools are unavailable", () => {
  const prompt = systemPrompt("/workspace", [
    descriptor("read"),
    descriptor("edit"),
    descriptor("write"),
  ])

  expect(prompt).toContain("modify workspace files directly")
  expect(prompt).toContain("show the exact proposed diff")
  expect(prompt).toContain("wait for the user's explicit acceptance")
  expect(prompt).not.toContain("generate an immutable proposal")
  expect(prompt).not.toContain("apply_file_changes")
  expect(prompt).not.toContain("reject_file_changes")
})

test("fails closed for an incomplete proposal lifecycle", () => {
  const prompt = systemPrompt("/workspace", [
    descriptor("edit"),
    descriptor("apply_file_changes"),
  ])

  expect(prompt).toContain("proposal lifecycle is incomplete")
  expect(prompt).toContain(
    "Do not use file-mutation tools until both apply_file_changes and reject_file_changes are available.",
  )
  expect(prompt).not.toContain("Apply a pending proposal")
  expect(prompt).not.toContain("modify workspace files directly")
})

test("does not claim unavailable tool capabilities", () => {
  const prompt = systemPrompt("/workspace", [descriptor("review")])

  expect(prompt).toContain("Active tools: review.")
  expect(prompt).not.toContain("Use find instead of shell commands")
  expect(prompt).not.toContain("Use grep to search file contents")
  expect(prompt).not.toContain("Before every Bash call")
  expect(prompt).not.toContain("file-mutation tool")
  expect(prompt).not.toContain("apply_file_changes")
})

test("gates instructions for individual file tools", () => {
  const prompt = systemPrompt("/workspace", [descriptor("edit")])

  expect(prompt).toContain("Use edit for precise changes")
  expect(prompt).not.toContain("Use write only for new files")
  expect(prompt).not.toContain("use read to ensure")
})

test("adds lower-priority workspace instructions before Buli policy", () => {
  const content = "Use the project formatter before committing."
  const prompt = systemPrompt(
    "/workspace",
    [descriptor("edit")],
    {
      source: ".buli/AGENTS.md",
      content,
    },
  )

  expect(prompt).toContain(
    '<workspace_instructions source=".buli/AGENTS.md">',
  )
  expect(prompt.match(/Use the project formatter before committing\./g)).toHaveLength(1)
  expect(prompt).toContain("have lower priority than Buli's instructions")
  expect(prompt.indexOf("</workspace_instructions>")).toBeLessThan(
    prompt.indexOf("You are not an autonomous executor"),
  )
  expect(prompt).toContain("modify workspace files directly")
})
