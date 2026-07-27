import { main } from "../src/cli.ts";

const [, , storagePath, sourcePath, displayName, gatePath] = Bun.argv;
if (!storagePath || !sourcePath || !displayName || !gatePath) {
  throw new Error("model CLI prepare worker requires storage, source, name, and gate paths");
}

while (!(await Bun.file(gatePath).exists())) await Bun.sleep(5);
const exitCode = await main(["model", "prepare", "--name", displayName, "--file", sourcePath], {
  modelStoragePath: storagePath,
});
if (exitCode !== 0) process.exit(exitCode);
