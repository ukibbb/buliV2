import { expect, test } from "bun:test"

interface ISourceFile {
  readonly path: string
  readonly source: string
}

const ALLOWED_DEPENDENCIES: Readonly<Record<string, ReadonlySet<string>>> = {
  agent: new Set(["agent", "common"]),
  app: new Set([
    "agent",
    "app",
    "authentication",
    "common",
    "providers",
    "sessions",
    "terminal",
    "tools",
  ]),
  authentication: new Set(["authentication", "common", "terminal"]),
  common: new Set(["common"]),
  providers: new Set(["agent", "authentication", "common", "providers"]),
  sessions: new Set(["agent", "common", "sessions", "terminal"]),
  terminal: new Set(["common", "terminal"]),
  tools: new Set(["agent", "common", "terminal", "tools"]),
}

const PRESENTATION_PREFIXES = [
  "src/app/entrypoints/",
  "src/app/ui/",
  "src/authentication/ui/",
  "src/sessions/ui/",
  "src/terminal/",
  "src/tools/ui/",
] as const

test("enforces feature dependency direction", async () => {
  const files = await readSourceFiles()
  const violations: string[] = []

  for (const feature of Object.keys(ALLOWED_DEPENDENCIES)) {
    expect(
      files.some(({ path }) => sourceFeature(path) === feature),
      `architecture scan missed src/${feature}`,
    ).toBe(true)
  }

  for (const file of files) {
    const owner = sourceFeature(file.path)
    const allowed = ALLOWED_DEPENDENCIES[owner]
    if (!allowed) {
      violations.push(`${file.path}: unknown source feature "${owner}"`)
      continue
    }

    for (const specifier of projectImports(file.source)) {
      const dependency = specifier.split("/")[0] ?? ""
      if (!ALLOWED_DEPENDENCIES[dependency]) {
        violations.push(`${file.path}: unknown import @/${specifier}`)
      } else if (!allowed.has(dependency)) {
        violations.push(`${file.path}: ${owner} must not depend on ${dependency}`)
      }
    }
  }

  expect(violations).toEqual([])
})

test("keeps framework code in presentation adapters", async () => {
  const files = await readSourceFiles()
  const violations: string[] = []

  for (const file of files) {
    const usesPresentationFramework = /["'](?:react|@opentui\/[^"']*)["']/.test(
      file.source,
    )
    if (
      usesPresentationFramework
      && !PRESENTATION_PREFIXES.some((prefix) => file.path.startsWith(prefix))
    ) {
      violations.push(`${file.path}: presentation framework in feature core`)
    }

    if (
      projectImports(file.source).some((specifier) => specifier === "terminal"
        || specifier.startsWith("terminal/"))
      && !PRESENTATION_PREFIXES.some((prefix) => file.path.startsWith(prefix))
    ) {
      violations.push(`${file.path}: terminal dependency outside presentation`)
    }
  }

  expect(violations).toEqual([])
})

test("uses public feature surfaces across boundaries", async () => {
  const files = await readSourceFiles()
  const violations: string[] = []

  for (const file of files) {
    const owner = sourceFeature(file.path)
    for (const specifier of projectImports(file.source)) {
      const dependency = specifier.split("/")[0] ?? ""
      if (dependency === owner) {
        if (specifier === owner) {
          violations.push(`${file.path}: implementation imports its own public barrel`)
        }
        continue
      }
      if (!isFeatureWithPublicSurface(dependency)) continue
      if (!isPublicFeatureSurface(specifier)) {
        violations.push(`${file.path}: private cross-feature import @/${specifier}`)
      }
    }
  }

  expect(violations).toEqual([])
})

test("does not restore obsolete architecture concepts", async () => {
  const files = await readSourceFiles()
  const violations: string[] = []
  const obsoleteConcepts = [
    "SessionEngine",
    "SessionStore",
    "SessionView",
    "BuliIterationState",
    "IUserBuliInteractionDriver",
    "BuliToolRegistry",
  ]
  const obsoleteRoots = new Set([
    "application",
    "auth",
    "conversation",
    "domain",
    "entrypoints",
    "platform",
    "session",
    "tui",
    "workspace",
  ])

  for (const file of files) {
    if (obsoleteRoots.has(sourceFeature(file.path))) {
      violations.push(`${file.path}: obsolete source root`)
    }
    for (const concept of obsoleteConcepts) {
      if (file.source.includes(concept)) violations.push(`${file.path}: ${concept}`)
    }
    for (const specifier of projectImports(file.source)) {
      const dependency = specifier.split("/")[0] ?? ""
      if (obsoleteRoots.has(dependency)) {
        violations.push(`${file.path}: obsolete import @/${specifier}`)
      }
    }
    if (/from\s+["'](?:\.\.\/)*pi(?:\/|["'])/.test(file.source)) {
      violations.push(`${file.path}: Pi implementation import`)
    }
    if (/from\s+["'](?:\.\.\/)*opencode-react(?:\/|["'])/.test(file.source)) {
      violations.push(`${file.path}: OpenCode implementation import`)
    }
  }

  expect(violations).toEqual([])
})

async function readSourceFiles(): Promise<readonly ISourceFile[]> {
  const files: ISourceFile[] = []
  const glob = new Bun.Glob("src/**/*.{ts,tsx}")
  for await (const path of glob.scan({ onlyFiles: true })) {
    files.push({ path, source: await Bun.file(path).text() })
  }
  expect(files.length, "architecture scan found no source files").toBeGreaterThan(0)
  return files
}

function sourceFeature(path: string): string {
  return path.split("/")[1] ?? ""
}

function projectImports(source: string): readonly string[] {
  return [...source.matchAll(/["']@\/([^"']+)["']/g)].map((match) => match[1] ?? "")
}

function isFeatureWithPublicSurface(feature: string): boolean {
  return feature === "agent"
    || feature === "authentication"
    || feature === "providers"
    || feature === "sessions"
    || feature === "tools"
}

function isPublicFeatureSurface(specifier: string): boolean {
  return specifier === "agent"
    || specifier === "authentication"
    || specifier === "authentication/ui"
    || specifier === "sessions"
    || specifier === "sessions/ui"
    || specifier === "tools"
    || specifier === "tools/ui"
    || /^providers\/[^/]+$/.test(specifier)
}
