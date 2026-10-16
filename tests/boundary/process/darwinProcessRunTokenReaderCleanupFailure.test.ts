import { access, chmod, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const removalGate = vi.hoisted(() => ({
  failing: false,
  failedPaths: [] as string[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    rm: async (...args: Parameters<typeof original.rm>) => {
      const target = args[0];
      if (
        removalGate.failing &&
        typeof target === "string" &&
        basename(target).startsWith("rea-process-token-")
      ) {
        removalGate.failedPaths.push(target);
        throw Object.assign(
          new Error(`EPERM: operation not permitted, unlink '${target}'`),
          { code: "EPERM", syscall: "unlink", path: target },
        );
      }
      return original.rm(...args);
    },
  };
});

import {
  createDarwinProcessRunTokenReader,
  DarwinProcessOwnershipInspectionError,
} from "../../../src/process/DarwinProcessRunTokenReader.js";

it.skipIf(process.platform === "win32")(
  "preserves the compiler failure when owned-root cleanup also fails",
  async () => {
    const directory = await createTestTempDirectory(
      "rea-darwin-cleanup-failure-test-",
    );
    const executable = join(directory, "failing-xcrun");
    await writeFile(
      executable,
      '#!/usr/bin/env node\nprocess.stderr.write("helper object directory vanished\\n"); process.exitCode = 1;\n',
    );
    await chmod(executable, 0o755);
    const reader = createDarwinProcessRunTokenReader({
      compiler: { kind: "xcrun", executable },
    });
    const exitListenersBefore = process.listenerCount("exit");
    let failure: unknown;
    removalGate.failing = true;
    try {
      await reader.prepare();
    } catch (cause: unknown) {
      failure = cause;
    } finally {
      removalGate.failing = false;
    }
    try {
      // The original compilation failure stays primary, with its structured
      // compiler outcome intact.
      expect(failure).toBeInstanceOf(DarwinProcessOwnershipInspectionError);
      const inspection = failure as DarwinProcessOwnershipInspectionError;
      expect(inspection.message).toBe(
        "macOS process ownership helper compilation failed via xcrun (compiler result: exit code 1): helper object directory vanished",
      );
      expect(inspection.compilerOutcome).toMatchObject({
        outcome: "exited",
        code: 1,
        signal: null,
        stderr: "helper object directory vanished\n",
      });
      // The cleanup rejection is reported separately, not in its place.
      const [failedRoot] = removalGate.failedPaths;
      if (failedRoot === undefined)
        throw new Error("expected a recorded failed removal");
      expect(failedRoot).toMatch(/rea-process-token-.+$/u);
      expect(inspection.cleanupFailure).toMatchObject({
        code: "EPERM",
        path: failedRoot,
      });
      // The failed cleanup keeps the root owned for a later retry.
      expect(process.listenerCount("exit")).toBe(exitListenersBefore + 1);
      await expect(access(failedRoot)).resolves.toBeUndefined();
      // A successful cleanup retry resolves the uncertainty and releases it.
      await reader.close();
      expect(process.listenerCount("exit")).toBe(exitListenersBefore);
      await expect(access(failedRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await reader.close().catch(() => undefined);
    }
  },
);
