import { describe, expect, it } from "vitest";
import {
  computeWorkbenchLayout,
  MIN_MAIN_WIDTH,
  MIN_PANEL_WIDTH,
  panelRatioFromDivider,
} from "../src/renderer/src/panel-layout";

describe("responsive workbench layout", () => {
  it("resizes the main workspace and side panel together while preserving the ratio", () => {
    const medium = computeWorkbenchLayout(1_320, 0.382);
    const wide = computeWorkbenchLayout(1_600, 0.382);
    expect(medium.panelCollapsed).toBe(false);
    expect(wide.panelCollapsed).toBe(false);
    expect(wide.mainWidth).toBeGreaterThan(medium.mainWidth);
    expect(wide.panelWidth).toBeGreaterThan(medium.panelWidth);
    expect(medium.mainWidth).toBeGreaterThanOrEqual(MIN_MAIN_WIDTH);
    expect(medium.panelWidth).toBeGreaterThanOrEqual(MIN_PANEL_WIDTH);
  });

  it("collapses the panel before either content column becomes unusably narrow", () => {
    const layout = computeWorkbenchLayout(1_060, 0.5);
    expect(layout.panelCollapsed).toBe(true);
    expect(layout.panelWidth).toBe(0);
    expect(layout.mainWidth).toBe(800);
  });

  it("clamps divider dragging to both column minimums", () => {
    const farLeft = panelRatioFromDivider(1_320, 320);
    const farRight = panelRatioFromDivider(1_320, 1_300);
    const leftLayout = computeWorkbenchLayout(1_320, farLeft);
    const rightLayout = computeWorkbenchLayout(1_320, farRight);
    expect(leftLayout.mainWidth).toBeGreaterThanOrEqual(MIN_MAIN_WIDTH);
    expect(rightLayout.panelWidth).toBeGreaterThanOrEqual(MIN_PANEL_WIDTH);
  });
});
