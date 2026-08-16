import { expect, test } from "bun:test"

test("keeps TUI code behind application and domain contracts", async () => {
  const violations: string[] = []
  const files = new Bun.Glob("src/tui/**/*.{ts,tsx}")

  for await (const path of files.scan({ onlyFiles: true })) {
    const source = await Bun.file(path).text()

    if (
      /from\s+["']@\/(?:agent|engine|providers|session|tools)(?:\/|["'])/.test(
        source,
      )
    ) {
      violations.push(`${path}: core implementation import`)
    }

    if (/\bBuliApplicationRuntime\b/.test(source)) {
      violations.push(`${path}: concrete application runtime`)
    }

    const applicationImports = source.matchAll(
      /from\s+["'](@\/application(?:\/[^"']*)?)["']/g,
    )
    for (const match of applicationImports) {
      if (match[1] !== "@/application/contracts") {
        violations.push(`${path}: application implementation import`)
      }
    }
  }

  expect(violations).toEqual([])
})

test("uses Agent ownership instead of the old engine-store-view stack", async () => {
  const violations: string[] = []
  const files = new Bun.Glob("src/**/*.{ts,tsx}")
  const obsoleteConcepts = [
    "SessionEngine",
    "SessionStore",
    "SessionView",
    "BuliIterationState",
    "IUserBuliInteractionDriver",
    "BuliToolRegistry",
  ]

  for await (const path of files.scan({ onlyFiles: true })) {
    const source = await Bun.file(path).text()
    for (const concept of obsoleteConcepts) {
      if (source.includes(concept)) violations.push(`${path}: ${concept}`)
    }

    if (/from\s+["'](?:\.\.\/)*pi(?:\/|["'])/.test(source)) {
      violations.push(`${path}: Pi implementation import`)
    }
  }

  expect(violations).toEqual([])
})
