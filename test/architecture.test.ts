import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { posix } from "node:path"

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
  ]),
  authentication: new Set(["authentication", "common"]),
  common: new Set(["common"]),
  providers: new Set(["agent", "authentication", "common", "providers"]),
  sessions: new Set(["agent", "common", "sessions"]),
  ui: new Set(["agent", "app", "authentication", "common", "sessions", "ui"]),
}

const PRESENTATION_PREFIXES = [
  "src/ui/",
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

    for (const specifier of projectImports(file.source, file.path)) {
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
      projectImports(file.source, file.path).some((specifier) => specifier === "ui"
        || specifier.startsWith("ui/"))
      && !PRESENTATION_PREFIXES.some((prefix) => file.path.startsWith(prefix))
    ) {
      violations.push(`${file.path}: UI dependency outside presentation`)
    }
  }

  expect(violations).toEqual([])
})

test("obsolete presentation directories are absent, including assets", () => {
  for (const path of [
    "src/app/ui", "src/app/entrypoints", "src/authentication/ui",
    "src/sessions/ui", "src/terminal",
  ]) {
    expect(existsSync(path), path).toBe(false)
  }
})

test("keeps the agent engine independent of concrete agents and tools", async () => {
  const files = await readSourceFiles()
  const engineFiles = files.filter(({ path }) => path.startsWith("src/agent/engine/"))
  expect(engineFiles.length).toBeGreaterThan(0)
  const violations: string[] = []

  for (const file of engineFiles) {
    for (const specifier of projectImports(file.source)) {
      if (/^agent\/(?:tools|definitions|prompts)(?:\/|$)/.test(specifier)
        || specifier === "agent/create-agent-definition"
        || specifier === "agent/definition") {
        violations.push(`${file.path}: engine depends on agent composition @/${specifier}`)
      }
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
    // Test fixtures may cross feature boundaries; enforce production dependencies only.
    if (/\.(test|spec)\.tsx?$/.test(path)) continue
    files.push({ path, source: await Bun.file(path).text() })
  }
  expect(files.length, "architecture scan found no source files").toBeGreaterThan(0)
  return files
}

function sourceFeature(path: string): string {
  return path.split("/")[1] ?? ""
}

function projectImports(source: string, path?: string): readonly string[] {
  const aliases = [...source.matchAll(/["']@\/([^"']+)["']/g)]
    .map((match) => match[1] ?? "")
  if (!path) return aliases
  const relatives = [...source.matchAll(/(?:from\s*|import\s*\(\s*|import\s*)["'](\.[^"']+)["']/g)]
    .map((match) => posix.normalize(posix.join(posix.dirname(path), match[1]!)))
    .filter((resolved) => resolved.startsWith("src/"))
    .map((resolved) => resolved.slice(4))
  return [...aliases, ...relatives]
}

function isFeatureWithPublicSurface(feature: string): boolean {
  return feature === "agent"
    || feature === "authentication"
    || feature === "providers"
    || feature === "sessions"
}

function isPublicFeatureSurface(specifier: string): boolean {
  return specifier === "agent"
    || specifier === "authentication"
    || specifier === "sessions"
    || specifier === "agent/tools"
    || specifier === "agent/definitions/buli"
    || /^providers\/[^/]+$/.test(specifier)
}
