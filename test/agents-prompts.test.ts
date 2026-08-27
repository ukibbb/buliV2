import { expect, test } from "bun:test"

import { systemPrompt } from "@/agent/system-prompt"
import type { AgentToolDescriptor } from "@/agent/tool"

const descriptor = (name: string): AgentToolDescriptor => ({
  name,
  description: `${name} description`,
  inputSchema: { type: "object" },
})

test("builds pair-programming instructions from active capabilities", () => {
  const prompt = systemPrompt("/workspace", [
    descriptor("read"),
    descriptor("glob"),
    descriptor("grep"),
    descriptor("apply_patch"),
    descriptor("bash"),
  ])

  expect(prompt).toContain("Aktywne narzędzia: read, glob, grep, apply_patch, bash.")
  expect(prompt).toContain("Nie jesteś autonomicznym wykonawcą")
  expect(prompt).toContain("Domyślnie użytkownik zachowuje ownership kodu")
  expect(prompt).toContain("apply_patch wolno wywołać tylko po jawnej prośbie")
  expect(prompt).toContain("Kontekst patcha kopiuj dokładnie z wyniku read")
  expect(prompt).toContain("małe, precyzyjnie zakotwiczone chunki")
  expect(prompt).toContain("samo wywołanie nie zmienia plików")
  expect(prompt).toContain("dopiero osobne Apply w UI")
  expect(prompt).toContain("Copy / Run once / Reject")
  expect(prompt).toContain("/bin/bash --noprofile --norc")
  expect(prompt).toContain("ustaw path w glob lub grep bezpośrednio na node_modules/<nazwa-pakietu>")
  expect(prompt).not.toContain("read_file")
  expect(prompt).not.toContain("<workspace_instructions")
})

test("does not claim unavailable tool capabilities", () => {
  const prompt = systemPrompt("/workspace", [descriptor("review")])

  expect(prompt).toContain("Aktywne narzędzia: review.")
  expect(prompt).not.toContain("Do znajdowania plików używaj glob")
  expect(prompt).not.toContain("apply_patch wolno wywołać")
  expect(prompt).not.toContain("Wywołanie Bash")
})

test("adds lower-priority workspace instructions before Buli policy", () => {
  const content = "Use the project formatter before committing."
  const prompt = systemPrompt(
    "/workspace",
    [descriptor("apply_patch")],
    {
      source: ".buli/AGENTS.md",
      content,
    },
  )

  expect(prompt).toContain(
    '<workspace_instructions source=".buli/AGENTS.md">',
  )
  expect(prompt).toContain(content)
  expect(prompt.match(/Use the project formatter before committing\./g)).toHaveLength(1)
  expect(prompt).toContain("mają niższy priorytet niż instrukcje Buli")
  expect(prompt.indexOf("</workspace_instructions>")).toBeLessThan(
    prompt.indexOf("Nie jesteś autonomicznym wykonawcą"),
  )
  expect(prompt).toContain("apply_patch wolno wywołać tylko po jawnej prośbie")
})
