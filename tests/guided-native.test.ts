import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareModelStorage } from "../src/guided-native.ts";

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
