export const DEFAULT_FAST_MODEL_ID = "deepseek-v4-flash";
export const DEFAULT_STRONG_MODEL_ID = "glm-5.3";
export const LEGACY_STRONG_MODEL_ID = "glm-5.3-flash";

export function migrateLegacyStrongModelId(model: string): string {
  return model === LEGACY_STRONG_MODEL_ID ? DEFAULT_STRONG_MODEL_ID : model;
}

export function configuredStrongModelId(value: string | undefined): string {
  const configured = value?.trim() || DEFAULT_STRONG_MODEL_ID;
  return migrateLegacyStrongModelId(configured);
}
