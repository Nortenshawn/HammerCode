import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ApiConnectionStore,
  customModelRef,
  normalizeApiBaseUrl,
  type CredentialCipher,
} from "../src/main/api-connection-store";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((item) => rm(item, { recursive: true, force: true })));
});

const cipher: CredentialCipher = {
  isAvailable: () => true,
  encrypt: (value) => Buffer.from([...Buffer.from(value, "utf8")].map((byte) => byte ^ 0xaa)),
  decrypt: (value) => Buffer.from([...value].map((byte) => byte ^ 0xaa)).toString("utf8"),
};

describe("custom API connection store", () => {
  it("normalizes supported base URLs and rejects unsafe remote URLs", () => {
    expect(normalizeApiBaseUrl("https://relay.example/v1/chat/completions")).toBe("https://relay.example/v1");
    expect(normalizeApiBaseUrl("http://localhost:8000/v1/models")).toBe("http://localhost:8000/v1");
    expect(() => normalizeApiBaseUrl("http://relay.example/v1")).toThrow();
    expect(() => normalizeApiBaseUrl("https://key@relay.example/v1")).toThrow();
  });

  it("probes /models, encrypts the key at rest and resolves discovered models", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hammercode-api-"));
    directories.push(directory);
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://relay.example/v1/models");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer secret-test-value" });
      return new Response(JSON.stringify({
        object: "list",
        data: [{ id: "model-b" }, { id: "model-a" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const store = new ApiConnectionStore(directory, cipher, fetchMock);
    await store.load();
    const saved = await store.save({ apiBaseUrl: "https://relay.example/v1", apiKey: "secret-test-value" });
    expect(saved.models).toEqual(["model-a", "model-b"]);
    expect(store.listPublic()[0]).not.toHaveProperty("encryptedApiKey");
    const raw = await readFile(path.join(directory, "api-connections.json"), "utf8");
    expect(raw).not.toContain("secret-test-value");
    expect(raw).toContain("encryptedApiKey");
    expect(store.resolve(customModelRef(saved.id, "model-a"))).toMatchObject({
      apiBaseUrl: "https://relay.example/v1",
      apiKey: "secret-test-value",
      model: "model-a",
    });
  });

  it("does not persist plaintext when secure storage is unavailable", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hammercode-api-"));
    directories.push(directory);
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ data: [{ id: "model" }] }),
      { status: 200 },
    )) as typeof fetch;
    const store = new ApiConnectionStore(directory, { ...cipher, isAvailable: () => false }, fetchMock);
    await store.load();
    await expect(store.save({ apiBaseUrl: "https://relay.example/v1", apiKey: "never-write-me" }))
      .rejects.toMatchObject({ code: "SECURE_STORAGE_UNAVAILABLE" });
    await expect(readFile(path.join(directory, "api-connections.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("distinguishes authentication and incompatible protocol failures", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hammercode-api-"));
    directories.push(directory);
    const unauthorized = new ApiConnectionStore(
      directory,
      cipher,
      vi.fn(async () => new Response("unauthorized", { status: 401 })) as typeof fetch,
    );
    await expect(unauthorized.test({ apiBaseUrl: "https://relay.example/v1", apiKey: "bad" }))
      .rejects.toMatchObject({ code: "API_AUTH_FAILED" });
    const incompatible = new ApiConnectionStore(
      directory,
      cipher,
      vi.fn(async () => new Response(JSON.stringify({ models: [] }), { status: 200 })) as typeof fetch,
    );
    await expect(incompatible.test({ apiBaseUrl: "https://relay.example/v1", apiKey: "bad" }))
      .rejects.toMatchObject({ code: "API_PROBE_INCOMPATIBLE" });
  });

  it("distinguishes HTTP, invalid JSON and oversized model-list responses", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hammercode-api-"));
    directories.push(directory);
    const input = { apiBaseUrl: "https://relay.example/v1", apiKey: "bad" };
    const unavailable = new ApiConnectionStore(
      directory,
      cipher,
      vi.fn(async () => new Response("temporary", { status: 503 })) as typeof fetch,
    );
    await expect(unavailable.test(input)).rejects.toMatchObject({ code: "API_PROBE_HTTP_ERROR" });

    const invalidJson = new ApiConnectionStore(
      directory,
      cipher,
      vi.fn(async () => new Response("not-json", { status: 200 })) as typeof fetch,
    );
    await expect(invalidJson.test(input)).rejects.toMatchObject({ code: "API_PROBE_INVALID_JSON" });

    const oversized = new ApiConnectionStore(
      directory,
      cipher,
      vi.fn(async () => new Response("{}", {
        status: 200,
        headers: { "Content-Length": "1000001" },
      })) as typeof fetch,
    );
    await expect(oversized.test(input)).rejects.toMatchObject({ code: "API_PROBE_RESPONSE_TOO_LARGE" });
  });
});
