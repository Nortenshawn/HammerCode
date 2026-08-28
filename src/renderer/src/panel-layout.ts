export interface WorkbenchLayout {
  sidebarWidth: number;
  mainWidth: number;
  panelWidth: number;
  panelCollapsed: boolean;
  panelRatio: number;
}

export const DEFAULT_PANEL_RATIO = 0.382;
export const MIN_MAIN_WIDTH = 520;
export const MIN_PANEL_WIDTH = 300;

export function navigationWidth(viewportWidth: number): number {
  return viewportWidth <= 1_080 ? 260 : 300;
}

export function computeWorkbenchLayout(
  viewportWidth: number,
  requestedPanelRatio = DEFAULT_PANEL_RATIO,
): WorkbenchLayout {
  const sidebarWidth = navigationWidth(viewportWidth);
  const available = Math.max(0, viewportWidth - sidebarWidth);
  const panelCollapsed = available < MIN_MAIN_WIDTH + MIN_PANEL_WIDTH;
  const safeRatio = Number.isFinite(requestedPanelRatio)
    ? Math.max(0.2, Math.min(0.62, requestedPanelRatio))
    : DEFAULT_PANEL_RATIO;
  if (panelCollapsed) {
    return {
      sidebarWidth,
      mainWidth: available,
      panelWidth: 0,
      panelCollapsed: true,
      panelRatio: safeRatio,
    };
  }
  const panelWidth = Math.max(
    MIN_PANEL_WIDTH,
    Math.min(available - MIN_MAIN_WIDTH, Math.round(available * safeRatio)),
  );
  return {
    sidebarWidth,
    mainWidth: available - panelWidth,
    panelWidth,
    panelCollapsed: false,
    panelRatio: panelWidth / available,
  };
}

export function panelRatioFromDivider(viewportWidth: number, dividerClientX: number): number {
  const sidebarWidth = navigationWidth(viewportWidth);
  const available = Math.max(1, viewportWidth - sidebarWidth);
  const requested = (viewportWidth - dividerClientX) / available;
  return computeWorkbenchLayout(viewportWidth, requested).panelRatio;
}
