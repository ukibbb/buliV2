import { spawn } from "node:child_process";
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
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY = "ukibbb/buliV2";
const packageRoot = dirname(fileURLToPath(import.meta.url));

export async function installBinary(options = {}) {
  const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const version = options.version ?? metadata.version;
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const fetchAsset = options.fetchAsset ?? fetch;
  const destination = options.destination ?? join(packageRoot, "vendor");
  const target = releaseTarget(platform, architecture);
  const asset = `buli-${target}.tar.gz`;
  const baseUrl = `https://github.com/${REPOSITORY}/releases/download/v${version}`;
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "buli-npm-install-"));

  try {
    const [archiveResponse, checksumResponse] = await Promise.all([
      fetchAsset(`${baseUrl}/${asset}`, requestOptions()),
      fetchAsset(`${baseUrl}/${asset}.sha256`, requestOptions()),
    ]);
    if (!archiveResponse.ok || !checksumResponse.ok) {
      throw new Error(
        `cannot download Buli ${version}: archive HTTP ${archiveResponse.status}, `
        + `checksum HTTP ${checksumResponse.status}`,
      );
    }

    const archive = new Uint8Array(await archiveResponse.arrayBuffer());
    const expectedChecksum = (await checksumResponse.text()).trim().split(/\s+/)[0];
    if (!expectedChecksum || !/^[0-9a-fA-F]{64}$/.test(expectedChecksum)) {
      throw new Error("release checksum has an invalid format");
    }
    const actualChecksum = createHash("sha256").update(archive).digest("hex");
    if (actualChecksum.toLowerCase() !== expectedChecksum.toLowerCase()) {
      throw new Error(`checksum verification failed for ${asset}`);
    }

    const archivePath = join(temporaryDirectory, asset);
    const extractionDirectory = join(temporaryDirectory, "extracted");
    await writeFile(archivePath, archive);
    await mkdir(extractionDirectory);
    await run("tar", [
      "--extract",
      "--gzip",
      "--file",
      archivePath,
      "--directory",
      extractionDirectory,
    ]);

    const bundle = join(extractionDirectory, `buli-${target}`);
    const executable = join(bundle, "bin", "buli");
    const ripgrep = join(bundle, "lib", "buli", "rg");
    await Promise.all([chmod(executable, 0o755), chmod(ripgrep, 0o755)]);
    const installedVersion = (await run(executable, ["--version"], true)).trim();
    if (installedVersion !== version) {
      throw new Error(
        `downloaded Buli reports version ${JSON.stringify(installedVersion)}, `
        + `expected ${JSON.stringify(version)}`,
      );
    }
    await run(ripgrep, ["--version"]);
    await readFile(join(bundle, "THIRD_PARTY_LICENSES"));

    const stagedDestination = join(temporaryDirectory, "vendor");
    await rename(bundle, stagedDestination);
    await rm(destination, { recursive: true, force: true });
    await rename(stagedDestination, destination);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function releaseTarget(platform, architecture) {
  const releasePlatform = platform === "darwin"
    ? "darwin"
    : platform === "linux" ? "linux" : undefined;
  const releaseArchitecture = architecture === "arm64"
    ? "arm64"
    : architecture === "x64" ? "x64" : undefined;
  if (!releasePlatform || !releaseArchitecture) {
    throw new Error(`unsupported platform ${platform}-${architecture}`);
  }
  return `${releasePlatform}-${releaseArchitecture}`;
}

function requestOptions() {
  return {
    headers: { "User-Agent": "@ukibbb/buli npm installer" },
    signal: AbortSignal.timeout(30_000),
  };
}

async function run(command, args, capture = false) {
  const child = spawn(command, args, {
    stdio: ["ignore", capture ? "pipe" : "ignore", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (exitCode !== 0) {
    throw new Error(
      `command failed with exit code ${exitCode}: ${command} ${args.join(" ")}\n${stderr.trim()}`,
    );
  }
  return stdout;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`))) {
  installBinary().catch((error) => {
    console.error(`buli npm installer: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
