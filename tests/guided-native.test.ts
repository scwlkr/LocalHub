import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareModelStorage, verifyPinnedRuntime } from "../src/guided-native.ts";
import type { RunBundle } from "../src/run.ts";

const roots: string[] = [];
const macOSProcessTest = process.platform === "darwin" ? test : test.skip;

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

macOSProcessTest(
  "pinned runtime verification queries an empty sealed router instead of Model Storage",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "localhub-runtime-sealed-router-"));
    roots.push(root);
    const modelStorage = join(root, "models");
    const staging = join(modelStorage, ".localhub-staging", "acquisition");
    const markerPath = join(root, "router-model-count.txt");
    const binaryPath = join(root, "llama-server");
    await prepareModelStorage(modelStorage);
    await mkdir(staging, { recursive: true });
    await Promise.all([
      writeFile(join(modelStorage, "adoptable.gguf"), "unverified"),
      writeFile(join(staging, "partial.gguf"), "partial"),
    ]);
    const source = `#!/usr/bin/env bun
import { readdir, writeFile } from "node:fs/promises";
const args = Bun.argv.slice(2);
if (args.includes("--version")) { console.log("version: 10107 (c0bc8591e)"); process.exit(0); }
if (args.includes("--list-devices")) { console.log("Metal: Test GPU"); process.exit(0); }
const value = (name) => args[args.indexOf(name) + 1];
async function ggufs(path) {
  const found = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = path + "/" + entry.name;
    if (entry.isDirectory()) found.push(...await ggufs(child));
    else if (entry.name.endsWith(".gguf")) found.push(child);
  }
  return found;
}
const server = Bun.serve({ hostname: value("--host"), port: Number(value("--port")), async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/health") return Response.json({ status: "ok" });
  if (path === "/models") { const models = await ggufs(value("--models-dir")); await writeFile(${JSON.stringify(markerPath)}, String(models.length)); return Response.json({ object: "list", data: models }); }
  return new Response("Not found", { status: 404 });
}});
process.on("SIGTERM", async () => { await server.stop(true); process.exit(0); });
`;
    await writeFile(binaryPath, source, { mode: 0o755 });
    const binaryBytes = await readFile(binaryPath);
    const bundle: RunBundle = {
      candidateId: "localhub-0.1.1-test-darwin-arm64",
      commit: "a".repeat(40),
      executable: { path: "lh", size: 100, sha256: "1".repeat(64) },
      llama: {
        archiveDigest: `sha256:${"2".repeat(64)}`,
        binary: {
          path: "runtime/llama.cpp/llama-server",
          size: binaryBytes.length,
          sha256: createHash("sha256").update(binaryBytes).digest("hex"),
        },
        binaryPath,
        build: "b10107",
        commit: "c0bc8591e8815c63cb01dd3f051a8b0df02501c9",
      },
    };

    const result = await verifyPinnedRuntime(bundle, modelStorage, 2_000);

    expect(result.noModelLoaded).toBeTrue();
    expect(await readFile(markerPath, "utf8")).toBe("0");
  },
);
