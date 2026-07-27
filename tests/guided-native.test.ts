import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareModelStorage, verifyPinnedRuntime } from "../src/guided-native.ts";
import type { RunBundle } from "../src/run.ts";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("unavailable Model Storage fails before LocalHub creates managed state", async () => {
  const root = await mkdtemp(join(tmpdir(), "localhub-storage-failure-"));
  roots.push(root);
  const unavailable = join(root, "not-a-folder");
  await writeFile(unavailable, "outside state remains intact");

  await expect(prepareModelStorage(unavailable)).rejects.toThrow("not a folder");

  expect(await readFile(unavailable, "utf8")).toBe("outside state remains intact");
});

test("Model Storage rejects managed-directory symlinks without touching their targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "localhub-storage-symlink-"));
  roots.push(root);
  const storage = join(root, "models");
  const outside = join(root, "outside");
  await Promise.all([mkdir(storage), mkdir(outside)]);
  await chmod(outside, 0o755);
  const outsideFile = join(outside, "keep.txt");
  await writeFile(outsideFile, "outside target remains untouched", { mode: 0o644 });
  await symlink(outside, join(storage, ".localhub-catalog"));
  const beforeMode = (await stat(outside)).mode & 0o777;

  await expect(prepareModelStorage(storage)).rejects.toThrow("symbolic link");

  expect(await readFile(outsideFile, "utf8")).toBe("outside target remains untouched");
  expect((await stat(outside)).mode & 0o777).toBe(beforeMode);
});

test("pinned runtime verification rejects a changed binary before execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "localhub-runtime-identity-"));
  roots.push(root);
  const binaryPath = join(root, "llama-server");
  await writeFile(binaryPath, "changed runtime bytes", { mode: 0o755 });
  const bundle: RunBundle = {
    candidateId: "localhub-0.1.1-test-darwin-arm64",
    commit: "a".repeat(40),
    executable: { path: "lh", size: 100, sha256: "1".repeat(64) },
    llama: {
      archiveDigest: `sha256:${"2".repeat(64)}`,
      binary: {
        path: "runtime/llama.cpp/llama-server",
        size: 100,
        sha256: "3".repeat(64),
      },
      binaryPath,
      build: "b10107",
      commit: "c0bc8591e8815c63cb01dd3f051a8b0df02501c9",
    },
  };

  await expect(verifyPinnedRuntime(bundle, root, 1_000)).rejects.toThrow("identity changed");
});
