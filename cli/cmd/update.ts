import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { CommandModule } from "yargs";
import packageMetadata from "../../package.json" with { type: "json" };

const LATEST_RELEASE_URL =
  "https://api.github.com/repos/ukibbb/buliV2/releases/latest";
const REPOSITORY = "ukibbb/buliV2";

type UpdateCommandArgs = {
  readonly check: boolean;
};

type TFetchRelease = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface ISemanticVersion {
  readonly source: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly (number | string)[];
}

export interface IUpdateCheckResult {
  readonly currentVersion: string;
  readonly latestVersion: string;
  readonly latestTag: string;
  readonly updateAvailable: boolean;
}

interface IStandaloneUpdateOptions {
  readonly fetchRelease?: TFetchRelease;
  readonly executablePath?: string;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
}

export const UpdateCommand: CommandModule<{}, UpdateCommandArgs> = {
  command: "update",
  describe: "update Buli to the latest stable release",
  builder: (command) => command
    .option("check", {
      type: "boolean",
      default: false,
      describe: "check for an update without changing the installation",
    }),
  handler: async ({ check }) => {
    const npmUpdateCommand = npmUpdateInstruction(process.execPath);
    if (npmUpdateCommand) {
      console.log("This Buli installation is managed by npm.");
      console.log(`Run: ${npmUpdateCommand}`);
      return;
    }
    const result = await checkForUpdate();
    console.log(`Current version: ${result.currentVersion}`);
    console.log(`Latest stable version: ${result.latestVersion}`);
    if (!result.updateAvailable) {
      console.log("Buli is up to date.");
      return;
    }
    if (check) {
      console.log(`Update available: ${result.latestVersion}`);
      return;
    }
    console.log(`Downloading Buli ${result.latestVersion}...`);
    await updateStandalone(result);
    console.log(`Buli was updated to ${result.latestVersion}.`);
  },
};

export async function checkForUpdate(
  fetchRelease: TFetchRelease = fetch,
  currentVersion = packageMetadata.version,
): Promise<IUpdateCheckResult> {
  const response = await fetchRelease(LATEST_RELEASE_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "buli-update-check",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) {
    throw new Error("No stable Buli release is available yet");
  }
  if (!response.ok) {
    throw new Error(`Cannot check for updates: GitHub returned HTTP ${response.status}`);
  }

  const release: unknown = await response.json();
  if (!isReleaseMetadata(release)) {
    throw new Error("Cannot check for updates: invalid GitHub release metadata");
  }
  if (release.draft || release.prerelease) {
    throw new Error("Cannot check for updates: GitHub latest release is not stable");
  }

  const current = parseSemanticVersion(currentVersion);
  const latest = parseSemanticVersion(release.tag_name);
  return {
    currentVersion: current.source,
    latestVersion: latest.source,
    latestTag: release.tag_name,
    updateAvailable: compareSemanticVersions(current, latest) < 0,
  };
}

export async function updateStandalone(
  result: IUpdateCheckResult,
  options: IStandaloneUpdateOptions = {},
): Promise<void> {
  const fetchRelease = options.fetchRelease ?? fetch;
  const executablePath = resolve(options.executablePath ?? process.execPath);
  const npmUpdateCommand = npmUpdateInstruction(executablePath);
  if (npmUpdateCommand) {
    throw new Error(
      "This Buli installation is managed by npm.\n"
      + `Run: ${npmUpdateCommand}`,
    );
  }
  const prefix = dirname(dirname(executablePath));
  const expectedExecutable = join(prefix, "bin", "buli");
  if (executablePath !== expectedExecutable) {
    throw new Error(
      "Cannot update this installation automatically; reinstall Buli or use its package manager",
    );
  }

  const target = releaseTarget(
    options.platform ?? process.platform,
    options.architecture ?? process.arch,
  );
  const asset = `buli-${target}.tar.gz`;
  const downloadBase =
    `https://github.com/${REPOSITORY}/releases/download/${result.latestTag}`;
  const updateDirectory = await mkdtemp(join(prefix, ".buli-update-"));

  try {
    const [archiveResponse, checksumResponse] = await Promise.all([
      fetchRelease(`${downloadBase}/${asset}`, downloadRequest()),
      fetchRelease(`${downloadBase}/${asset}.sha256`, downloadRequest()),
    ]);
    if (!archiveResponse.ok || !checksumResponse.ok) {
      throw new Error(
        `Cannot download Buli update: archive HTTP ${archiveResponse.status}, `
        + `checksum HTTP ${checksumResponse.status}`,
      );
    }

    const archive = new Uint8Array(await archiveResponse.arrayBuffer());
    const checksum = (await checksumResponse.text()).trim().split(/\s+/)[0];
    if (!checksum || !/^[0-9a-fA-F]{64}$/.test(checksum)) {
      throw new Error("Buli update checksum has an invalid format");
    }
    const actualChecksum = createHash("sha256").update(archive).digest("hex");
    if (actualChecksum.toLowerCase() !== checksum.toLowerCase()) {
      throw new Error(`Checksum verification failed for ${asset}`);
    }

    const archivePath = join(updateDirectory, asset);
    const extractionDirectory = join(updateDirectory, "extracted");
    await writeFile(archivePath, archive);
    await mkdir(extractionDirectory);
    await run([
      "tar",
      "--extract",
      "--gzip",
      "--file",
      archivePath,
      "--directory",
      extractionDirectory,
    ]);

    const bundleDirectory = join(extractionDirectory, `buli-${target}`);
    const stagedExecutable = join(bundleDirectory, "bin", "buli");
    const stagedRipgrep = join(bundleDirectory, "lib", "buli", "rg");
    const stagedLicenses = join(bundleDirectory, "THIRD_PARTY_LICENSES");
    await Promise.all([
      chmod(stagedExecutable, 0o755),
      chmod(stagedRipgrep, 0o755),
    ]);
    const installedVersion = (await run([stagedExecutable, "--version"], true)).trim();
    if (installedVersion !== result.latestVersion) {
      throw new Error(
        `Downloaded Buli reports version ${JSON.stringify(installedVersion)}, `
        + `expected ${JSON.stringify(result.latestVersion)}`,
      );
    }
    await run([stagedRipgrep, "--version"]);
    await readFile(stagedLicenses);

    await replaceInstallation([
      { source: stagedRipgrep, destination: join(prefix, "lib", "buli", "rg") },
      {
        source: stagedLicenses,
        destination: join(prefix, "share", "buli", "THIRD_PARTY_LICENSES"),
      },
      { source: stagedExecutable, destination: expectedExecutable },
    ]);
  } finally {
    await rm(updateDirectory, { recursive: true, force: true });
  }
}

export function npmUpdateInstruction(executablePath: string): string | undefined {
  const normalized = resolve(executablePath).replaceAll("\\", "/");
  if (!normalized.endsWith("/node_modules/@ukibbb/buli/vendor/bin/buli")) {
    return undefined;
  }
  const distTag = packageMetadata.version.includes("-") ? "next" : "latest";
  return `npm install --global @ukibbb/buli@${distTag}`;
}

async function replaceInstallation(
  files: readonly { readonly source: string; readonly destination: string }[],
): Promise<void> {
  const replaced: Array<{ readonly destination: string; readonly backup: string }> = [];
  try {
    for (const file of files) {
      const backup = `${file.destination}.buli-backup-${process.pid}`;
      await rm(backup, { force: true });
      await rename(file.destination, backup);
      try {
        await rename(file.source, file.destination);
      } catch (error) {
        await rename(backup, file.destination);
        throw error;
      }
      replaced.push({ destination: file.destination, backup });
    }
  } catch (error) {
    for (const file of replaced.reverse()) {
      await rm(file.destination, { force: true });
      await rename(file.backup, file.destination);
    }
    throw error;
  }
  await Promise.all(replaced.map(({ backup }) => rm(backup, { force: true })));
}

function releaseTarget(platform: NodeJS.Platform, architecture: string): string {
  const releasePlatform = platform === "darwin"
    ? "darwin"
    : platform === "linux" ? "linux" : undefined;
  const releaseArchitecture = architecture === "arm64" || architecture === "aarch64"
    ? "arm64"
    : architecture === "x64" || architecture === "x86_64" ? "x64" : undefined;
  if (!releasePlatform || !releaseArchitecture) {
    throw new Error(`Unsupported update target ${platform}-${architecture}`);
  }
  return `${releasePlatform}-${releaseArchitecture}`;
}

function downloadRequest(): RequestInit {
  return {
    headers: { "User-Agent": "buli-update" },
    signal: AbortSignal.timeout(30_000),
  };
}

async function run(command: readonly string[], capture = false): Promise<string> {
  const child = Bun.spawn([...command], {
    stdin: "ignore",
    stdout: capture ? "pipe" : "ignore",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    capture ? new Response(child.stdout).text() : Promise.resolve(""),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `Command failed with exit code ${exitCode}: ${command.join(" ")}\n${stderr.trim()}`,
    );
  }
  return stdout;
}

function isReleaseMetadata(
  value: unknown,
): value is { readonly tag_name: string; readonly draft: boolean; readonly prerelease: boolean } {
  if (typeof value !== "object" || value === null) return false;
  const release = value as Record<string, unknown>;
  return typeof release.tag_name === "string"
    && typeof release.draft === "boolean"
    && typeof release.prerelease === "boolean";
}

function parseSemanticVersion(value: string): ISemanticVersion {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new Error(`Cannot check for updates: invalid semantic version ${JSON.stringify(value)}`);
  }
  const prerelease = match[4]?.split(".").map((identifier) => {
    if (/^\d+$/.test(identifier)) {
      if (identifier.length > 1 && identifier.startsWith("0")) {
        throw new Error(`Cannot check for updates: invalid semantic version ${JSON.stringify(value)}`);
      }
      return Number(identifier);
    }
    return identifier;
  }) ?? [];
  return {
    source: value.startsWith("v") ? value.slice(1) : value,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

function compareSemanticVersions(left: ISemanticVersion, right: ISemanticVersion): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length
      ? 0
      : left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === rightIdentifier ? 0 : leftIdentifier === undefined ? -1 : 1;
    }
    if (leftIdentifier === rightIdentifier) continue;
    if (typeof leftIdentifier === "number" && typeof rightIdentifier === "string") return -1;
    if (typeof leftIdentifier === "string" && typeof rightIdentifier === "number") return 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}
