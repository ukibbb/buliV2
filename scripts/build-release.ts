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
import packageMetadata from "../package.json" with { type: "json" }

const RIPGREP_VERSION = "14.1.1"
const releaseTag = process.env.BULI_RELEASE_TAG
const expectedReleaseTag = `v${packageMetadata.version}`
if (releaseTag !== undefined && releaseTag !== expectedReleaseTag) {
    throw new Error(
        `Release tag ${JSON.stringify(releaseTag)} does not match package version `
        + `${JSON.stringify(packageMetadata.version)}; expected ${expectedReleaseTag}`,
    )
}
const TARGETS = {
    "darwin-arm64": {
        platform: "darwin",
        arch: "arm64",
        ripgrepAsset: `ripgrep-${RIPGREP_VERSION}-aarch64-apple-darwin`,
        ripgrepSha256: "24ad76777745fbff131c8fbc466742b011f925bfa4fffa2ded6def23b5b937be",
    },
    "darwin-x64": {
        platform: "darwin",
        arch: "x64",
        ripgrepAsset: `ripgrep-${RIPGREP_VERSION}-x86_64-apple-darwin`,
        ripgrepSha256: "fc87e78f7cb3fea12d69072e7ef3b21509754717b746368fd40d88963630e2b3",
    },
    "linux-arm64": {
        platform: "linux",
        arch: "arm64",
        ripgrepAsset: `ripgrep-${RIPGREP_VERSION}-aarch64-unknown-linux-gnu`,
        ripgrepSha256: "c827481c4ff4ea10c9dc7a4022c8de5db34a5737cb74484d62eb94a95841ab2f",
    },
    "linux-x64": {
        platform: "linux",
        arch: "x64",
        ripgrepAsset: `ripgrep-${RIPGREP_VERSION}-x86_64-unknown-linux-musl`,
        ripgrepSha256: "4cf9f2741e6c465ffdb7c26f38056a59e2a2544b51f7cc128ef28337eeae4d8e",
    },
} as const

type TReleaseTarget = keyof typeof TARGETS

const requestedTarget = process.env.BULI_RELEASE_TARGET
    ?? `${process.platform}-${process.arch}`
if (!(requestedTarget in TARGETS)) {
    throw new Error(
        `Unsupported release target ${JSON.stringify(requestedTarget)}; expected one of `
        + Object.keys(TARGETS).join(", "),
    )
}
const targetName = requestedTarget as TReleaseTarget
const TARGET = {
    ...TARGETS[targetName],
    bundleName: `buli-${targetName}`,
}

const workspaceRoot = resolve(import.meta.dir, "..")
const distDirectory = join(workspaceRoot, "dist")
const bundleDirectory = join(distDirectory, TARGET.bundleName)
const archivePath = `${bundleDirectory}.tar.gz`
const archiveChecksumPath = `${archivePath}.sha256`

if (process.platform !== TARGET.platform || process.arch !== TARGET.arch) {
    throw new Error(
        `Release target ${targetName} requires ${TARGET.platform}-${TARGET.arch}, got `
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

    if (TARGET.platform === "darwin") {
        await run([
            "codesign",
            "--remove-signature",
            buliExecutable,
        ])
        await run([
            "codesign",
            "--force",
            "--sign",
            "-",
            "--timestamp=none",
            buliExecutable,
        ])
        await run([
            "codesign",
            "--verify",
            "--deep",
            "--strict",
            buliExecutable,
        ])
    }

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
    await run([buliExecutable, "--version"])
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
