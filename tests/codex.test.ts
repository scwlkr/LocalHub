import { describe, expect, test } from "bun:test";
import { buildCodexProcess, runCodex, type SpawnCodex } from "../src/codex.ts";

describe("Codex process construction", () => {
  test("uses process-scoped provider overrides and preserves cwd/model", () => {
    const spec = buildCodexProcess({
      codexPath: "/usr/local/bin/codex",
      modelId: "runtime/kimi-3-instance",
      endpoint: "http://127.0.0.1:1234",
      contextLength: 65_536,
      cwd: "/work/project with spaces",
      baseEnv: { PATH: "/bin" },
    });

    expect(spec.command.slice(0, 5)).toEqual([
      "/usr/local/bin/codex",
      "--model",
      "runtime/kimi-3-instance",
      "--cd",
      "/work/project with spaces",
    ]);
    expect(spec.command.join(" ")).toContain('model_provider="localhub_lmstudio"');
    expect(spec.command.join(" ")).toContain("model_context_window=65536");
    expect(spec.command.join(" ")).toContain('base_url="http://127.0.0.1:1234/v1"');
    expect(spec.command.join(" ")).toContain('wire_api="responses"');
    expect(spec.cwd).toBe("/work/project with spaces");
    expect(spec.env).toEqual({ PATH: "/bin" });
  });

  test("passes auth only through a child-scoped environment variable", () => {
    const spec = buildCodexProcess({
      codexPath: "codex",
      modelId: "model",
      endpoint: "http://macbook.local:1234",
      contextLength: 65_536,
      cwd: "C:\\repo",
      token: "super-secret",
      baseEnv: {},
    });
    expect(spec.command.join(" ")).not.toContain("super-secret");
    expect(spec.command.join(" ")).toContain('env_key="LOCALHUB_LMSTUDIO_TOKEN"');
    expect(spec.env.LOCALHUB_LMSTUDIO_TOKEN).toBe("super-secret");
  });

  test("inherits the terminal and returns Codex's exit code", async () => {
    const seenOptions: Array<Parameters<SpawnCodex>[1]> = [];
    const code = await runCodex(
      {
        command: ["codex", "--version"],
        cwd: "/project",
        env: { PATH: "/bin" },
      },
      (_command, options) => {
        seenOptions.push(options);
        return { exited: Promise.resolve(7) };
      },
    );
    expect(code).toBe(7);
    expect(seenOptions[0]).toEqual({
      cwd: "/project",
      env: { PATH: "/bin" },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
  });
});
