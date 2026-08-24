import { createHash } from "node:crypto"
import { expect, test } from "bun:test"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const workspaceRoot = import.meta.dir + "/.."

test.skipIf(process.platform === "win32")(
  "installs a verified release bundle and updates PATH idempotently",
  async () => {
    const fixture = await createInstallerFixture()
    try {
      const first = await runInstaller(fixture)
      expect(first.exitCode).toBe(0)
      expect(first.stderr).toBe("")
      expect(first.stdout).toContain("Buli v0.1.0-rc.2 installed")
      expect(await readFile(join(fixture.prefix, "bin", "buli"), "utf8"))
        .toContain("fixture buli")
      expect(await readFile(join(fixture.prefix, "lib", "buli", "rg"), "utf8"))
        .toContain("fixture ripgrep")
      expect(await readFile(
        join(fixture.prefix, "share", "buli", "THIRD_PARTY_LICENSES"),
        "utf8",
      )).toBe("fixture licenses\n")

      const second = await runInstaller(fixture)
      expect(second.exitCode).toBe(0)
      const zshrc = await readFile(join(fixture.home, ".zshrc"), "utf8")
      expect(zshrc.match(/# Added by the Buli installer/g)).toHaveLength(1)
      expect(zshrc).toContain(`export PATH='${fixture.prefix}/bin':"$PATH"`)
      expect(await readFile(fixture.curlLog, "utf8")).toContain(
        "/releases/download/v0.1.0-rc.2/buli-darwin-arm64.tar.gz",
      )
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform === "win32")(
  "rejects a bundle whose checksum does not match",
  async () => {
    const fixture = await createInstallerFixture()
    try {
      await writeFile(fixture.checksum, `${"0".repeat(64)}  bundle.tar.gz\n`)
      const result = await runInstaller(fixture)
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("checksum verification failed")
      expect(Bun.file(join(fixture.prefix, "bin", "buli")).exists())
        .resolves.toBe(false)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  },
)

interface IInstallerFixture {
  readonly root: string
  readonly home: string
  readonly prefix: string
  readonly mockBin: string
  readonly archive: string
  readonly checksum: string
  readonly curlLog: string
}

async function createInstallerFixture(): Promise<IInstallerFixture> {
  const root = await mkdtemp(join(tmpdir(), "buli-installer-test-"))
  const home = join(root, "home")
  const prefix = join(home, ".local")
  const mockBin = join(root, "mock-bin")
  const bundle = join(root, "bundle", "buli-darwin-arm64")
  const archive = join(root, "buli-darwin-arm64.tar.gz")
  const checksum = `${archive}.sha256`
  const curlLog = join(root, "curl.log")
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(mockBin, { recursive: true }),
    mkdir(join(bundle, "bin"), { recursive: true }),
    mkdir(join(bundle, "lib", "buli"), { recursive: true }),
  ])
  await writeExecutable(
    join(bundle, "bin", "buli"),
    "#!/bin/sh\nprintf 'fixture buli\\n'\n",
  )
  await writeExecutable(
    join(bundle, "lib", "buli", "rg"),
    "#!/bin/sh\nprintf 'fixture ripgrep\\n'\n",
  )
  await writeFile(join(bundle, "THIRD_PARTY_LICENSES"), "fixture licenses\n")
  await run(["tar", "-czf", archive, "-C", join(root, "bundle"), "buli-darwin-arm64"])
  const archiveBytes = await readFile(archive)
  const digest = createHash("sha256").update(archiveBytes).digest("hex")
  await writeFile(checksum, `${digest}  buli-darwin-arm64.tar.gz\n`)

  await writeExecutable(join(mockBin, "uname"), `#!/bin/sh
if [ "\${1:-}" = "-s" ]; then printf 'Darwin\\n'; else printf 'arm64\\n'; fi
`)
  await writeExecutable(join(mockBin, "curl"), `#!/bin/sh
output=''
url=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    --*) shift ;;
    *) url="$1"; shift ;;
  esac
done
printf '%s\\n' "$url" >> "$BULI_TEST_CURL_LOG"
case "$url" in
  *.sha256) cp "$BULI_TEST_CHECKSUM" "$output" ;;
  *.tar.gz) cp "$BULI_TEST_ARCHIVE" "$output" ;;
  *) exit 90 ;;
esac
`)
  return { root, home, prefix, mockBin, archive, checksum, curlLog }
}

async function runInstaller(fixture: IInstallerFixture): Promise<{
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}> {
  const child = Bun.spawn(["/bin/sh", join(workspaceRoot, "install.sh"), "v0.1.0-rc.2"], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      HOME: fixture.home,
      SHELL: "/bin/zsh",
      PATH: `${fixture.mockBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      BULI_INSTALL_PREFIX: fixture.prefix,
      BULI_TEST_ARCHIVE: fixture.archive,
      BULI_TEST_CHECKSUM: fixture.checksum,
      BULI_TEST_CURL_LOG: fixture.curlLog,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { exitCode, stdout, stderr }
}

async function writeExecutable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents)
  await chmod(path, 0o755)
}

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stderr, exitCode] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(`Fixture command failed: ${stderr}`)
}
