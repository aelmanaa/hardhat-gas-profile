import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "node:test";

/** A fresh temporary directory for each test, removed after it. */
export function createTmpDir(prefix: string): { path: string } {
  const dir = { path: "" };
  beforeEach(async () => {
    dir.path = await mkdtemp(path.join(tmpdir(), `${prefix}-`));
  });
  afterEach(async () => {
    await rm(dir.path, { recursive: true, force: true });
  });
  return dir;
}
