import { arch, cpus, freemem, hostname, platform, totalmem } from "node:os";
import type { SystemInfo } from "./types.ts";

export function collectSystemInfo(cwd = process.cwd()): SystemInfo {
  const currentPlatform = platform();
  return {
    platform: currentPlatform,
    arch: arch(),
    hostname: hostname(),
    cpu: cpus()[0]?.model ?? "unknown",
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: currentPlatform === "darwin" ? null : freemem(),
    cwd,
  };
}

export function findCodex(which: (command: string) => string | null = Bun.which): string | null {
  return which("codex");
}
