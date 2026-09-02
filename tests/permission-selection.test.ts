import { describe, expect, it } from "vitest";
import { permissionSelectionAction } from "../src/renderer/src/permission-selection";

describe("permission selection", () => {
  it("requires a visible confirmation every time full access is selected", () => {
    expect(permissionSelectionAction("full_access")).toBe("confirm_full_access");
    expect(permissionSelectionAction("full_access")).toBe("confirm_full_access");
  });

  it("persists request-approval mode without the full-access warning", () => {
    expect(permissionSelectionAction("ask")).toBe("persist");
  });
});
