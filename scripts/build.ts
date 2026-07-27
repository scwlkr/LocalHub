export {};

const MINIMUM_BUN_VERSION = "1.3.14";

const TARGETS = {
  "bun-darwin-arm64": {
    platform: "darwin",
    arch: "arm64",
    outfile: "dist/lh",
  },
  "bun-windows-x64": {
    platform: "win32",
    arch: "x64",
    outfile: "dist/lh.exe",
  },
} as const;

type Target = keyof typeof TARGETS;

const nativeTarget: Target | null =
  process.platform === "darwin" && process.arch === "arm64"
    ? "bun-darwin-arm64"
    : process.platform === "win32" && process.arch === "x64"
      ? "bun-windows-x64"
      : null;
const requested = Bun.argv[2] as Target | undefined;
const target = requested ?? nativeTarget;
const buildCommit = await gitCommit();

if (!versionAtLeast(Bun.version, MINIMUM_BUN_VERSION)) {
  console.error(
    `Standalone builds require Bun ${MINIMUM_BUN_VERSION} or newer; found ${Bun.version}.`,
  );
  process.exitCode = 2;
} else if (!target || !(target in TARGETS)) {
  console.error("Builds require macOS arm64 or Windows x64.");
  process.exitCode = 2;
} else {
  const definition = TARGETS[target];
  if (definition.platform !== process.platform || definition.arch !== process.arch) {
    console.error(
      `${target} must be built on its matching host so OpenTUI's native package can be executed and verified.`,
    );
    process.exitCode = 2;
  } else {
    const build = Bun.spawn(
      [
        process.execPath,
        "build",
        "--compile",
        "--minify",
        `--target=${target}`,
        "--env=LOCALHUB_BUILD_*",
        "src/cli.ts",
        "--outfile",
        definition.outfile,
      ],
      {
        env: { ...process.env, LOCALHUB_BUILD_COMMIT: buildCommit },
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    const buildCode = await build.exited;
    if (buildCode !== 0) {
      process.exitCode = buildCode;
    } else {
      const signCode =
        process.platform === "darwin"
          ? await Bun.spawn(["codesign", "--force", "--sign", "-", definition.outfile], {
              stdin: "inherit",
              stdout: "inherit",
              stderr: "inherit",
            }).exited
          : 0;
      if (signCode !== 0) {
        process.exitCode = signCode;
      } else {
        const smoke = Bun.spawn([definition.outfile, "--version"], {
          stdin: "ignore",
          stdout: "inherit",
          stderr: "inherit",
        });
        process.exitCode = await smoke.exited;
      }
    }
  }
}

async function gitCommit(): Promise<string> {
  const process = Bun.spawn(["git", "rev-parse", "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout] = await Promise.all([process.exited, new Response(process.stdout).text()]);
  const commit = stdout.trim();
  if (code !== 0 || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error("Standalone builds require an exact Git source commit.");
  }
  return commit;
}

function versionAtLeast(actual: string, minimum: string): boolean {
  const actualParts = actual.split(".").map(Number);
  const minimumParts = minimum.split(".").map(Number);
  for (let index = 0; index < Math.max(actualParts.length, minimumParts.length); index += 1) {
    const actualPart = actualParts[index] ?? 0;
    const minimumPart = minimumParts[index] ?? 0;
    if (actualPart !== minimumPart) {
      return actualPart > minimumPart;
    }
  }
  return true;
}
