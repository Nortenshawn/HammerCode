import { describe, expect, it } from "vitest";
import {
  configuredStrongModelId,
  DEFAULT_STRONG_MODEL_ID,
  migrateLegacyStrongModelId,
} from "../src/main/model-defaults";

describe("model defaults", () => {
  it("uses GLM-5.3 by default and normalizes the legacy Flash environment value", () => {
    expect(configuredStrongModelId(undefined)).toBe(DEFAULT_STRONG_MODEL_ID);
    expect(configuredStrongModelId("glm-5.3-flash")).toBe(DEFAULT_STRONG_MODEL_ID);
    expect(configuredStrongModelId("  glm-5.3-flash  ")).toBe(DEFAULT_STRONG_MODEL_ID);
  });

  it("does not rewrite unrelated custom model IDs", () => {
    expect(configuredStrongModelId("relay-strong-model")).toBe("relay-strong-model");
    expect(migrateLegacyStrongModelId("GLM-5.3-FLASH")).toBe("GLM-5.3-FLASH");
  });
});
