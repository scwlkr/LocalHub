import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { assembleExpandCandidate } from "../src/release.ts";
import { VERSION } from "../src/version.ts";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  console.error("Expand candidates must be assembled natively on macOS arm64.");
  process.exit(2);
}

const repository = join(import.meta.dir, "..");
const sourceExecutable = join(repository, "dist", "lh");
const commit = await command(["git", "rev-parse", "HEAD"], repository);
const status = await command(["git", "status", "--porcelain", "--untracked-files=no"], repository);
if (status.length !== 0) {
  console.error("Candidate assembly requires a clean tracked source commit.");
  process.exit(2);
}
if (!(await Bun.file(sourceExecutable).exists())) {
  console.error("Missing dist/lh. Build the native standalone executable first.");
  process.exit(2);
}
await expectExit([sourceExecutable, "--version"], 0);
await expectExit([sourceExecutable, "--help"], 0);
await expectExit(["codesign", "--verify", "--strict", sourceExecutable], 0);

const productVersion = await command(["sw_vers", "-productVersion"], repository);
const buildVersion = await command(["sw_vers", "-buildVersion"], repository);
const exactTag = await optionalCommand(
  ["git", "describe", "--exact-match", "--tags", "HEAD"],
  repository,
);
const candidatesDirectory = join(repository, "dist", "candidates");
await mkdir(candidatesDirectory, { recursive: true });
const outputDirectory = join(
  candidatesDirectory,
  `localhub-${VERSION}-${commit.slice(0, 12)}-darwin-arm64`,
);
const paths = await assembleExpandCandidate({
  assembledAt: new Date(),
  commit,
  outputDirectory,
  sourceExecutable,
  tag: exactTag,
  testedOsVersion: `${productVersion} (${buildVersion})`,
  version: VERSION,
});
await expectExit([paths.executablePath, "release", "identity", paths.candidateRecordPath], 0);
console.log(JSON.stringify(paths, null, 2));

async function command(commandLine: string[], cwd: string): Promise<string> {
  const process = Bun.spawn(commandLine, { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(`${commandLine[0]} failed: ${stderr.trim()}`);
  }
  return stdout.trim();
}

async function optionalCommand(commandLine: string[], cwd: string): Promise<string | null> {
  const process = Bun.spawn(commandLine, { cwd, stdout: "pipe", stderr: "ignore" });
  const [code, stdout] = await Promise.all([process.exited, new Response(process.stdout).text()]);
  return code === 0 ? stdout.trim() : null;
}

async function expectExit(commandLine: string[], expected: number): Promise<void> {
  const process = Bun.spawn(commandLine, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const code = await process.exited;
  if (code !== expected) {
    throw new Error(`${commandLine[0]} exited ${code}; expected ${expected}.`);
  }
}
