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

    const authImports = source.matchAll(
      /from\s+["'](@\/auth(?:\/[^"']*)?)["']/g,
    )
    for (const match of authImports) {
      if (match[1] !== "@/auth/contracts") {
        violations.push(`${path}: concrete authentication import`)
      }
    }
  }

  expect(violations).toEqual([])
})

test("keeps authentication core independent from providers and UI", async () => {
  const violations: string[] = []
  const files = new Bun.Glob("src/auth/**/*.{ts,tsx}")

  for await (const path of files.scan({ onlyFiles: true })) {
    const source = await Bun.file(path).text()
    // Concrete providers are wired in composition; auth core exposes only ports,
    // credential storage and provider-independent orchestration.
    if (
      /from\s+["']@\/(?:providers|tui|composition|entrypoints)(?:\/|["'])/.test(
        source,
      )
    ) {
      violations.push(`${path}: outer-layer import`)
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
    if (/from\s+["'](?:\.\.\/)*opencode-react(?:\/|["'])/.test(source)) {
      violations.push(`${path}: OpenCode implementation import`)
    }
  }

  expect(violations).toEqual([])
})
