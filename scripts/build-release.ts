import { createHash } from "node:crypto"
import {
    chmod,
    copyFile,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"

const RIPGREP_VERSION = "14.1.1"
const TARGET = {
    platform: "darwin",
    arch: "arm64",
    bundleName: "buli-darwin-arm64",
    ripgrepAsset: `ripgrep-${RIPGREP_VERSION}-aarch64-apple-darwin`,
    ripgrepSha256: "24ad76777745fbff131c8fbc466742b011f925bfa4fffa2ded6def23b5b937be",
} as const

const workspaceRoot = resolve(import.meta.dir, "..")
const distDirectory = join(workspaceRoot, "dist")
const bundleDirectory = join(distDirectory, TARGET.bundleName)
const archivePath = `${bundleDirectory}.tar.gz`
const archiveChecksumPath = `${archivePath}.sha256`

if (process.platform !== TARGET.platform || process.arch !== TARGET.arch) {
    throw new Error(
        `Local release bundle supports ${TARGET.platform}-${TARGET.arch}, got `
        + `${process.platform}-${process.arch}`,
    )
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), "buli-release-"))

try {
    const ripgrepArchivePath = join(temporaryDirectory, `${TARGET.ripgrepAsset}.tar.gz`)
    const ripgrepExtractionDirectory = join(temporaryDirectory, "ripgrep")
    const ripgrepUrl = `https://github.com/BurntSushi/ripgrep/releases/download/`
        + `${RIPGREP_VERSION}/${TARGET.ripgrepAsset}.tar.gz`

    const response = await fetch(ripgrepUrl)
    if (!response.ok) {
        throw new Error(`Cannot download ripgrep: HTTP ${response.status}`)
    }
    const ripgrepArchive = Buffer.from(await response.arrayBuffer())
    const ripgrepChecksum = sha256(ripgrepArchive)
    if (ripgrepChecksum !== TARGET.ripgrepSha256) {
        throw new Error(
            `ripgrep checksum mismatch: expected ${TARGET.ripgrepSha256}, got `
            + ripgrepChecksum,
        )
    }
    await writeFile(ripgrepArchivePath, ripgrepArchive)

    await mkdir(ripgrepExtractionDirectory, { recursive: true })
    await run([
        "tar",
        "--extract",
        "--gzip",
        "--file",
        ripgrepArchivePath,
        "--directory",
        ripgrepExtractionDirectory,
    ])

    await Promise.all([
        rm(bundleDirectory, { recursive: true, force: true }),
        rm(archivePath, { force: true }),
        rm(archiveChecksumPath, { force: true }),
    ])
    const binDirectory = join(bundleDirectory, "bin")
    const libraryDirectory = join(bundleDirectory, "lib", "buli")
    await Promise.all([
        mkdir(binDirectory, { recursive: true }),
        mkdir(libraryDirectory, { recursive: true }),
    ])

    const buliExecutable = join(binDirectory, "buli")
    await run([
        process.execPath,
        "build",
        "--compile",
        join(workspaceRoot, "cli", "main.ts"),
        "--outfile",
        buliExecutable,
    ], workspaceRoot)

    const extractedRoot = join(ripgrepExtractionDirectory, TARGET.ripgrepAsset)
    const ripgrepExecutable = join(libraryDirectory, "rg")
    await copyFile(join(extractedRoot, "rg"), ripgrepExecutable)
    await chmod(ripgrepExecutable, 0o755)

    const thirdPartyLicenses = await buildThirdPartyLicenses(extractedRoot)
    await writeFile(
        join(bundleDirectory, "THIRD_PARTY_LICENSES"),
        thirdPartyLicenses,
        "utf8",
    )

    await run([buliExecutable, "--help"])
    await run([ripgrepExecutable, "--version"])
    await run([
        "tar",
        "--create",
        "--gzip",
        "--file",
        archivePath,
        "--directory",
        distDirectory,
        basename(bundleDirectory),
    ])

    const archive = await readFile(archivePath)
    await writeFile(
        archiveChecksumPath,
        `${sha256(archive)}  ${basename(archivePath)}\n`,
        "utf8",
    )

    console.log(`Created ${archivePath}`)
    console.log(`Created ${archiveChecksumPath}`)
} finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
}

async function buildThirdPartyLicenses(extractedRoot: string): Promise<string> {
    const sections = await Promise.all([
        licenseSection(extractedRoot, "COPYING"),
        licenseSection(extractedRoot, "LICENSE-MIT"),
        licenseSection(extractedRoot, "UNLICENSE"),
    ])
    return [
        `ripgrep ${RIPGREP_VERSION}`,
        "Source: https://github.com/BurntSushi/ripgrep",
        "",
        ...sections,
    ].join("\n")
}

async function licenseSection(root: string, name: string): Promise<string> {
    const contents = await readFile(join(root, name), "utf8")
    return `===== ${name} =====\n${contents.trim()}\n`
}

function sha256(contents: Uint8Array): string {
    return createHash("sha256").update(contents).digest("hex")
}

async function run(command: readonly string[], cwd = workspaceRoot): Promise<void> {
    const child = Bun.spawn([...command], {
        cwd,
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
    })
    const exitCode = await child.exited
    if (exitCode !== 0) {
        throw new Error(
            `Command failed with exit code ${exitCode}: ${command.join(" ")}`,
        )
    }
}
