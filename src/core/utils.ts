import { randomUUID } from "node:crypto";
import type { Clock, IdGenerator } from "./types";

export const systemClock: Clock = { now: () => new Date() };

export const uuidGenerator: IdGenerator = {
  next(prefix: string): string {
    return `${prefix}_${randomUUID()}`;
  },
};

export function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

export function abortError(message = "操作已取消"): Error {
  return new DOMException(message, "AbortError");
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

export function redactSecrets(input: string): string {
  return input
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_API_KEY]")
    .replace(/([?&](?:api_?key|token|access_?token)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(
      /((?:DEEPSEEK_API_KEY|OPENAI_API_KEY|API_KEY)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    );
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return redactSecrets(error.message);
  return redactSecrets(String(error));
}
