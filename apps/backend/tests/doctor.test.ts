import { describe, expect, it } from "bun:test";
import type { ExportStatus } from "../src/operations/backup-export.js";
import { doctorChecks } from "../src/operations/doctor.js";
import { loadTestConfig } from "./helpers/studio-config.js";

const backedUp: ExportStatus = { kind: "media", at: "2026-08-20T00:00:00.000Z", bytes: 1, ageDays: 1, ok: true };

describe("doctor checks", () => {
  it("reports optional authoring interfaces without failing a site-only Studio", () => {
    const siteOnly = doctorChecks(
      loadTestConfig({ COMMAND_CENTER_TOKEN: "command-center" }),
      [{ name: "DATA_DIR", path: "/data", writable: true }],
      backedUp,
    );
    expect(siteOnly.requiredChecks).toEqual({ dataDirectoriesWritable: true, mediaBackedUp: true });
    expect(siteOnly.checks.telegramBot).toBe(false);

    const config = loadTestConfig({ CONTROLLER_BOT_TOKEN: "bot", COMMAND_CENTER_TOKEN: "command-center" });
    const result = doctorChecks(config, [{ name: "DATA_DIR", path: "/data", writable: true }], backedUp);

    expect(result.checks.telegramBot).toBe(true);
    expect(result.checks.commandCenterTokenConfigured).toBe(true);
  });

  it("fails a deployment whose media has not left the host", () => {
    const config = loadTestConfig({ COMMAND_CENTER_TOKEN: "command-center" });
    const directories = [{ name: "DATA_DIR", path: "/data", writable: true }];
    const never = doctorChecks(config, directories, { ...backedUp, at: null, bytes: null, ageDays: null, ok: false });
    expect(never.requiredChecks.mediaBackedUp).toBe(false);

    // An export the backup host stopped repeating is no better than none.
    const stale = doctorChecks(config, directories, { ...backedUp, ageDays: 9, ok: false });
    expect(stale.requiredChecks.mediaBackedUp).toBe(false);
  });
});
