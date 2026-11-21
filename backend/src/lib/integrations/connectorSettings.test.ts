import { describe, expect, it } from "vitest";
import { connectorSettingsPatch, toggleDisabledTool } from "./connectorSettings";

describe("connectorSettingsPatch", () => {
  it("maps enabled and readOnly through unchanged", () => {
    expect(connectorSettingsPatch({ enabled: true, readOnly: false })).toEqual({
      enabled: true,
      read_only: false,
    });
    expect(connectorSettingsPatch({ enabled: false, readOnly: true })).toEqual({
      enabled: false,
      read_only: true,
    });
  });

  it("returns an empty patch for an empty settings object", () => {
    expect(connectorSettingsPatch({})).toEqual({});
  });

  // Gate B4 audit finding L5a/L5b: requireWriteApproval is accepted in the
  // input type (so a stale caller is not rejected outright) but must never
  // produce a database write — true or false, it is always dropped.
  it.each([true, false])(
    "drops requireWriteApproval=%s entirely, with or without other fields",
    (requireWriteApproval) => {
      expect(connectorSettingsPatch({ requireWriteApproval })).toEqual({});
      expect(
        connectorSettingsPatch({ requireWriteApproval, enabled: true }),
      ).toEqual({ enabled: true });
      expect(
        Object.keys(connectorSettingsPatch({ requireWriteApproval })),
      ).not.toContain("require_write_approval");
    },
  );

  it("ignores a non-boolean field instead of coercing it", () => {
    expect(
      connectorSettingsPatch({
        enabled: "yes" as unknown as boolean,
        readOnly: undefined,
      }),
    ).toEqual({});
  });
});

describe("toggleDisabledTool", () => {
  it("adds a tool to the disabled list when turned off", () => {
    expect(toggleDisabledTool([], "send_email", false)).toEqual(["send_email"]);
  });

  it("does not duplicate an already-disabled tool", () => {
    expect(toggleDisabledTool(["send_email"], "send_email", false)).toEqual([
      "send_email",
    ]);
  });

  it("removes a tool from the disabled list when turned on", () => {
    expect(
      toggleDisabledTool(["send_email", "delete_file"], "send_email", true),
    ).toEqual(["delete_file"]);
  });

  it("is a no-op enabling a tool that was never disabled", () => {
    expect(toggleDisabledTool(["delete_file"], "send_email", true)).toEqual([
      "delete_file",
    ]);
  });
});
