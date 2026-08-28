import { expect, test } from "bun:test"

import { systemPrompt } from "@/agent/system-prompt"
import type { IAgentToolDescriptor } from "@/agent/tool"

const descriptor = (name: string): IAgentToolDescriptor => ({
  name,
  description: `${name} description`,
  inputSchema: { type: "object" },
})

test("builds pair-programming instructions from active capabilities", () => {
  const prompt = systemPrompt("/workspace", [
    descriptor("read"),
    descriptor("find"),
    descriptor("grep"),
    descriptor("edit"),
    descriptor("write"),
    descriptor("bash"),
    descriptor("tool_output"),
  ])

  expect(prompt).toContain(
    "Aktywne narzędzia: read, find, grep, edit, write, bash, tool_output.",
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
  expect(prompt).toContain("Nie jesteś autonomicznym wykonawcą")
  expect(prompt).toContain("Domyślnie użytkownik zachowuje ownership kodu")
  expect(prompt).toContain(
    "pokazać użytkownikowi dokładny diff z wyjaśnieniem i zaczekać na jego jednoznaczną akceptację w rozmowie",
  )
  expect(prompt).toContain(
    "pokaż dokładny proponowany diff, krótko wyjaśnij każdą zmianę i zaczekaj na jednoznaczną akceptację użytkownika w kolejnej wiadomości",
  )
  expect(prompt).toContain(
    "Po akceptacji zastosuj dokładnie ten diff bez ponownego pytania",
  )
  expect(prompt).toContain(
    "Te narzędzia zapisują bezpośrednio i nie otwierają modala",
  )
  expect(prompt).toContain("Każde edits[].oldText kopiuj z aktualnego wyniku read")
  expect(prompt).toContain("musi być unikalne w oryginalnym pliku")
  expect(prompt).toContain("Używaj write tylko do nowych plików")
  expect(prompt).toContain(
    "Przed każdym wywołaniem Bash pokaż użytkownikowi dokładną komendę oraz timeout albo wyraźnie zaznacz jego brak",
  )
  expect(prompt).toContain("znaczenie programu/subkomend/flag/argumentów/operatorów")
  expect(prompt).toContain("zaczekaj na jej jednoznaczną pisemną akceptację w kolejnej wiadomości")
  expect(prompt).toContain("Akceptacja dotyczy wyłącznie dokładnie pokazanej komendy i timeoutu")
  expect(prompt).toContain("Bash wykonuje komendę bezpośrednio i nie otwiera modala")
  expect(prompt).toContain("/bin/bash --noprofile --norc")
  expect(prompt).toContain("encoding=base64")
  expect(prompt).toContain("nie traktuj inline preview jako pełnego wyniku")
  expect(prompt).toContain("zwiększ limit albo zawęź pattern lub path")
  expect(prompt).toContain("zwiększ limit albo zawęź pattern, glob lub path")
  expect(prompt).toContain("ustaw path w find lub grep bezpośrednio na node_modules/<nazwa-pakietu>")
  expect(prompt).not.toContain("samo wywołanie nie zmienia plików")
  expect(prompt).not.toContain("dopiero osobne Apply w UI")
  expect(prompt).not.toContain("apply_patch")
  expect(prompt).not.toContain("read_file")
  expect(prompt).not.toContain("Copy / Run once / Reject")
  expect(prompt).not.toContain("<workspace_instructions")
})

test("does not claim unavailable tool capabilities", () => {
  const prompt = systemPrompt("/workspace", [descriptor("review")])

  expect(prompt).toContain("Aktywne narzędzia: review.")
  expect(prompt).not.toContain("Do znajdowania plików używaj find")
  expect(prompt).not.toContain("Te narzędzia zapisują bezpośrednio")
  expect(prompt).not.toContain("Przed każdym wywołaniem Bash")
})

test("adds lower-priority workspace instructions before Buli policy", () => {
  const content = "Use the project formatter before committing."
  const prompt = systemPrompt(
    "/workspace",
    [descriptor("edit"), descriptor("write")],
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
  expect(prompt).toContain(
    "przed pierwszym wywołaniem edit albo write nadal musisz pokazać użytkownikowi dokładny diff z wyjaśnieniem",
  )
  expect(prompt).toContain("jednoznaczną akceptację w rozmowie")
})
