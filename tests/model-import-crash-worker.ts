import { writeFile } from "node:fs/promises";
import { importLocalModel } from "../src/model-acquisition.ts";

const [, , storagePath, acquisitionId, markerPath] = Bun.argv;
if (!storagePath || !acquisitionId || !markerPath) {
  throw new Error("model import crash worker requires storage, acquisition, and marker paths");
}

await importLocalModel(storagePath, acquisitionId, {
  beforeCatalogCommit: async () => {
    await writeFile(markerPath, "promoted", { mode: 0o600 });
    await new Promise<void>(() => undefined);
  },
});
