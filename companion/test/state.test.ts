// DATA_DIR's env precedence. This is the seam Qurelay's container depends
// on: harness and sidecar share one mounted volume, and OMB_DATA_DIR is the
// only variable set to point both of them at it.
import { afterEach, describe, expect, it, vi } from "vitest";

describe("DATA_DIR", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("honors OMB_DATA_DIR, so the harness and sidecar can share one data directory", async () => {
    vi.resetModules();
    vi.stubEnv("OMB_DATA_DIR", "/data");
    vi.stubEnv("OMB_COMPANION_DIR", "/should-not-win");
    const { DATA_DIR } = await import("../src/state.ts");
    expect(DATA_DIR).toBe("/data");
  });

  it("falls back to OMB_COMPANION_DIR when OMB_DATA_DIR is unset", async () => {
    vi.resetModules();
    delete process.env.OMB_DATA_DIR;
    vi.stubEnv("OMB_COMPANION_DIR", "/companion-only");
    const { DATA_DIR } = await import("../src/state.ts");
    expect(DATA_DIR).toBe("/companion-only");
  });
});
