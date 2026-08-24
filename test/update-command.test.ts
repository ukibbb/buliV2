import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkForUpdate,
  npmUpdateInstruction,
  updateStandalone,
} from "../cli/cmd/update";

test("reports a newer stable release without modifying the installation", async () => {
  const requests: Array<{
    readonly input: string;
    readonly init: RequestInit | undefined;
  }> = [];
  const result = await checkForUpdate(async (input, init) => {
    requests.push({ input: String(input), init });
    return Response.json({ tag_name: "v0.2.0", draft: false, prerelease: false });
  }, "0.1.0-rc.5");

  expect(result).toEqual({
    currentVersion: "0.1.0-rc.5",
    latestVersion: "0.2.0",
    latestTag: "v0.2.0",
    updateAvailable: true,
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.input).toBe(
    "https://api.github.com/repos/ukibbb/buliV2/releases/latest",
  );
  expect(requests[0]?.init?.headers).toMatchObject({
    Accept: "application/vnd.github+json",
    "User-Agent": "buli-update-check",
  });
});

test("treats a stable release as newer than its release candidate", async () => {
  const result = await checkForUpdate(
    async () => Response.json({ tag_name: "v0.1.0", draft: false, prerelease: false }),
    "0.1.0-rc.5",
  );

  expect(result.updateAvailable).toBe(true);
});

test("reports an equal stable release as up to date", async () => {
  const result = await checkForUpdate(
    async () => Response.json({ tag_name: "v1.2.3", draft: false, prerelease: false }),
    "1.2.3",
  );

  expect(result.updateAvailable).toBe(false);
});

test("rejects failed and malformed GitHub responses", async () => {
  await expect(checkForUpdate(
    async () => new Response(null, { status: 404 }),
  )).rejects.toThrow("No stable Buli release is available yet");
  await expect(checkForUpdate(
    async () => new Response(null, { status: 503 }),
  )).rejects.toThrow("GitHub returned HTTP 503");
  await expect(checkForUpdate(
    async () => Response.json({ tag_name: 123, draft: false, prerelease: false }),
  )).rejects.toThrow("invalid GitHub release metadata");
  await expect(checkForUpdate(
    async () => Response.json({ tag_name: "v0.2.0-rc.1", draft: false, prerelease: true }),
  )).rejects.toThrow("GitHub latest release is not stable");
});

test("directs npm installations to the matching dist-tag", async () => {
  const executablePath = "/tmp/node_modules/@ukibbb/buli/vendor/bin/buli";
  expect(npmUpdateInstruction(executablePath, "0.1.0-rc.6"))
    .toBe("npm install --global @ukibbb/buli@next");
  expect(npmUpdateInstruction(executablePath, "0.1.0"))
    .toBe("npm install --global @ukibbb/buli@latest");
  expect(npmUpdateInstruction("/tmp/bin/buli", "0.1.0-rc.6")).toBeUndefined();
  await expect(updateStandalone({
    currentVersion: "0.1.0-rc.6",
    latestVersion: "0.1.0",
    latestTag: "v0.1.0",
    updateAvailable: true,
  }, {
    executablePath,
  })).rejects.toThrow("Run: npm install --global @ukibbb/buli@next");
});

test.skipIf(process.platform === "win32")(
  "downloads, verifies, validates, and replaces a standalone installation",
  async () => {
    const fixture = await createUpdateFixture();
    try {
      await updateStandalone(fixture.result, {
        executablePath: fixture.executable,
        platform: "darwin",
        architecture: "arm64",
        fetchRelease: fixture.fetchRelease,
      });
      expect(await readFile(fixture.executable, "utf8")).toContain("0.2.0");
      expect(await readFile(join(fixture.prefix, "lib", "buli", "rg"), "utf8"))
        .toContain("new rg");
      expect(await readFile(
        join(fixture.prefix, "share", "buli", "THIRD_PARTY_LICENSES"),
        "utf8",
      )).toBe("new licenses\n");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "leaves the existing installation untouched when checksum verification fails",
  async () => {
    const fixture = await createUpdateFixture("0".repeat(64));
    try {
      await expect(updateStandalone(fixture.result, {
        executablePath: fixture.executable,
        platform: "darwin",
        architecture: "arm64",
        fetchRelease: fixture.fetchRelease,
      })).rejects.toThrow("Checksum verification failed");
      expect(await readFile(fixture.executable, "utf8")).toContain("old buli");
      expect(await readFile(join(fixture.prefix, "lib", "buli", "rg"), "utf8"))
        .toContain("old rg");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);

async function createUpdateFixture(checksumOverride?: string) {
  const root = await mkdtemp(join(tmpdir(), "buli-update-test-"));
  const prefix = join(root, "prefix");
  const executable = join(prefix, "bin", "buli");
  const bundle = join(root, "bundle", "buli-darwin-arm64");
  await Promise.all([
    mkdir(join(prefix, "bin"), { recursive: true }),
    mkdir(join(prefix, "lib", "buli"), { recursive: true }),
    mkdir(join(prefix, "share", "buli"), { recursive: true }),
    mkdir(join(bundle, "bin"), { recursive: true }),
    mkdir(join(bundle, "lib", "buli"), { recursive: true }),
  ]);
  await Promise.all([
    writeExecutable(executable, "#!/bin/sh\nprintf 'old buli\\n'\n"),
    writeExecutable(
      join(prefix, "lib", "buli", "rg"),
      "#!/bin/sh\nprintf 'old rg\\n'\n",
    ),
    writeFile(join(prefix, "share", "buli", "THIRD_PARTY_LICENSES"), "old licenses\n"),
    writeExecutable(join(bundle, "bin", "buli"), "#!/bin/sh\nprintf '0.2.0\\n'\n"),
    writeExecutable(
      join(bundle, "lib", "buli", "rg"),
      "#!/bin/sh\nprintf 'new rg\\n'\n",
    ),
    writeFile(join(bundle, "THIRD_PARTY_LICENSES"), "new licenses\n"),
  ]);

  const archivePath = join(root, "buli-darwin-arm64.tar.gz");
  const tar = Bun.spawn([
    "tar",
    "--create",
    "--gzip",
    "--file",
    archivePath,
    "--directory",
    join(root, "bundle"),
    "buli-darwin-arm64",
  ]);
  if (await tar.exited !== 0) throw new Error("Cannot create updater test archive");
  const archive = await readFile(archivePath);
  const checksum = checksumOverride
    ?? createHash("sha256").update(archive).digest("hex");
  const fetchRelease = async (input: string | URL | Request): Promise<Response> =>
    String(input).endsWith(".sha256")
      ? new Response(`${checksum}  buli-darwin-arm64.tar.gz\n`)
      : new Response(archive);
  return {
    root,
    prefix,
    executable,
    fetchRelease,
    result: {
      currentVersion: "0.1.0",
      latestVersion: "0.2.0",
      latestTag: "v0.2.0",
      updateAvailable: true,
    },
  };
}

async function writeExecutable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}
