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
import npmPackageMetadata from "../npm/package.json" with { type: "json" }

const RIPGREP_VERSION = "14.1.1"
const FD_VERSION = "10.3.0"
const BUNDLE_VERSION = "2"

const releaseTag = process.env.BULI_RELEASE_TAG
const expectedReleaseTag = `v${packageMetadata.version}`

if (npmPackageMetadata.version !== packageMetadata.version) {
    throw new Error(
        `npm package version ${JSON.stringify(npmPackageMetadata.version)} does not match `
        + `release version ${JSON.stringify(packageMetadata.version)}`,
    )
}
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
        fdAsset: `fd-v${FD_VERSION}-aarch64-apple-darwin`,
        fdSha256: "0570263812089120bc2a5d84f9e65cd0c25e4a4d724c80075c357239c74ae904",
    },
    "darwin-x64": {
        platform: "darwin",
        arch: "x64",
        ripgrepAsset: `ripgrep-${RIPGREP_VERSION}-x86_64-apple-darwin`,
        ripgrepSha256: "fc87e78f7cb3fea12d69072e7ef3b21509754717b746368fd40d88963630e2b3",
        fdAsset: `fd-v${FD_VERSION}-x86_64-apple-darwin`,
        fdSha256: "50d30f13fe3d5914b14c4fff5abcbd4d0cdab4b855970a6956f4f006c17117a3",
    },
    "linux-arm64": {
        platform: "linux",
        arch: "arm64",
        ripgrepAsset: `ripgrep-${RIPGREP_VERSION}-aarch64-unknown-linux-gnu`,
        ripgrepSha256: "c827481c4ff4ea10c9dc7a4022c8de5db34a5737cb74484d62eb94a95841ab2f",
        fdAsset: `fd-v${FD_VERSION}-aarch64-unknown-linux-musl`,
        fdSha256: "996b9b1366433b211cb3bbedba91c9dbce2431842144d925428ead0adf32020b",
    },
    "linux-x64": {
        platform: "linux",
        arch: "x64",
        ripgrepAsset: `ripgrep-${RIPGREP_VERSION}-x86_64-unknown-linux-musl`,
        ripgrepSha256: "4cf9f2741e6c465ffdb7c26f38056a59e2a2544b51f7cc128ef28337eeae4d8e",
        fdAsset: `fd-v${FD_VERSION}-x86_64-unknown-linux-musl`,
        fdSha256: "2b6bfaae8c48f12050813c2ffe1884c61ea26e750d803df9c9114550a314cd14",
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
    const fdArchivePath = join(temporaryDirectory, `${TARGET.fdAsset}.tar.gz`)
    const fdExtractionDirectory = join(temporaryDirectory, "fd")
    const ripgrepUrl = `https://github.com/BurntSushi/ripgrep/releases/download/`
        + `${RIPGREP_VERSION}/${TARGET.ripgrepAsset}.tar.gz`
    const fdUrl = `https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/`
        + `${TARGET.fdAsset}.tar.gz`

    const [ripgrepResponse, fdResponse] = await Promise.all([
        fetch(ripgrepUrl),
        fetch(fdUrl),
    ])
    if (!ripgrepResponse.ok) {
        throw new Error(`Cannot download ripgrep: HTTP ${ripgrepResponse.status}`)
    }
    if (!fdResponse.ok) {
        throw new Error(`Cannot download fd: HTTP ${fdResponse.status}`)
    }
    const [ripgrepArchive, fdArchive] = await Promise.all([
        ripgrepResponse.arrayBuffer().then(Buffer.from),
        fdResponse.arrayBuffer().then(Buffer.from),
    ])
    const ripgrepChecksum = sha256(ripgrepArchive)
    if (ripgrepChecksum !== TARGET.ripgrepSha256) {
        throw new Error(
            `ripgrep checksum mismatch: expected ${TARGET.ripgrepSha256}, got `
            + ripgrepChecksum,
        )
    }
    const fdChecksum = sha256(fdArchive)
    if (fdChecksum !== TARGET.fdSha256) {
        throw new Error(
            `fd checksum mismatch: expected ${TARGET.fdSha256}, got ${fdChecksum}`,
        )
    }
    await writeFile(ripgrepArchivePath, ripgrepArchive)
    await writeFile(fdArchivePath, fdArchive)

    await Promise.all([
        mkdir(ripgrepExtractionDirectory, { recursive: true }),
        mkdir(fdExtractionDirectory, { recursive: true }),
    ])
    await Promise.all([
        run([
            "tar",
            "--extract",
            "--gzip",
            "--file",
            ripgrepArchivePath,
            "--directory",
            ripgrepExtractionDirectory,
        ]),
        run([
            "tar",
            "--extract",
            "--gzip",
            "--file",
            fdArchivePath,
            "--directory",
            fdExtractionDirectory,
        ]),
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
    const extractedFdRoot = join(fdExtractionDirectory, TARGET.fdAsset)
    const ripgrepExecutable = join(libraryDirectory, "rg")
    const fdExecutable = join(libraryDirectory, "fd")
    await copyFile(join(extractedRoot, "rg"), ripgrepExecutable)
    await copyFile(join(extractedFdRoot, "fd"), fdExecutable)
    await Promise.all([
        chmod(ripgrepExecutable, 0o755),
        chmod(fdExecutable, 0o755),
    ])

    const thirdPartyLicenses = await buildThirdPartyLicenses(
        extractedRoot,
        extractedFdRoot,
    )
    await writeFile(
        join(bundleDirectory, "THIRD_PARTY_LICENSES"),
        thirdPartyLicenses,
        "utf8",
    )
    await writeFile(join(bundleDirectory, "BUNDLE_VERSION"), `${BUNDLE_VERSION}\n`, "utf8")

    await run([buliExecutable, "--help"])
    await run([buliExecutable, "--version"])
    await run([ripgrepExecutable, "--version"])
    await run([fdExecutable, "--version"])
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

async function buildThirdPartyLicenses(
    ripgrepRoot: string,
    fdRoot: string,
): Promise<string> {
    const treeSitterRoot = join(
        workspaceRoot,
        "src",
        "terminal",
        "assets",
        "tree-sitter",
    )
    const [
        ripgrepSections,
        fdSections,
        piNotice,
        pythonLicense,
        bashLicense,
    ] = await Promise.all([
        Promise.all([
            licenseSection(ripgrepRoot, "COPYING"),
            licenseSection(ripgrepRoot, "LICENSE-MIT"),
            licenseSection(ripgrepRoot, "UNLICENSE"),
        ]),
        Promise.all([
            licenseSection(fdRoot, "LICENSE-APACHE"),
            licenseSection(fdRoot, "LICENSE-MIT"),
        ]),
        licenseSection(workspaceRoot, "THIRD_PARTY_NOTICES"),
        licenseSection(treeSitterRoot, "LICENSE.tree-sitter-python"),
        licenseSection(treeSitterRoot, "LICENSE.tree-sitter-bash"),
    ])
    // Parser binaries are embedded, so their notices must ship beside Buli.
    return [
        `ripgrep ${RIPGREP_VERSION}`,
        "Source: https://github.com/BurntSushi/ripgrep",
        "",
        ...ripgrepSections,
        "",
        `fd ${FD_VERSION}`,
        "Source: https://github.com/sharkdp/fd",
        "",
        ...fdSections,
        "",
        piNotice,
        "",
        "tree-sitter-python 0.23.6",
        "Source: https://github.com/tree-sitter/tree-sitter-python",
        "",
        pythonLicense,
        "",
        "tree-sitter-bash 0.25.0",
        "Source: https://github.com/tree-sitter/tree-sitter-bash",
        "",
        bashLicense,
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
