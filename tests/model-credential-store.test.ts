import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ModelCredentialStore,
  normalizeApiBaseUrl,
  type CredentialCipher,
} from "../src/main/model-credential-store";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((item) => rm(item, { recursive: true, force: true })));
});

const cipher: CredentialCipher = {
  isAvailable: () => true,
  encrypt: (value: string) => Buffer.from([...Buffer.from(value, "utf8")].map((byte) => byte ^ 0xaa)),
  decrypt: (value: Buffer) => Buffer.from([...value].map((byte) => byte ^ 0xaa)).toString("utf8"),
};

const fallbacks = {
  fast: { apiKey: "fast-env-key", apiBaseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash" },
  strong: { apiKey: "strong-env-key", apiBaseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-5.3-flash" },
};

describe("fixed model credential store", () => {
  it("normalizes safe endpoints and rejects unsafe remote URLs", () => {
    expect(normalizeApiBaseUrl("https://relay.example/v1/chat/completions")).toBe("https://relay.example/v1");
    expect(normalizeApiBaseUrl("http://localhost:8000/v1/models")).toBe("http://localhost:8000/v1");
    expect(() => normalizeApiBaseUrl("http://relay.example/v1")).toThrow();
    expect(() => normalizeApiBaseUrl("https://key@relay.example/v1")).toThrow();
  });

  it("imports only Fast/Strong fallbacks, encrypts them and removes the legacy connection list", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hammercode-models-"));
    directories.push(directory);
    await writeFile(path.join(directory, "api-connections.json"), JSON.stringify({
      version: 1,
      connections: [{
        apiBaseUrl: "http://127.0.0.1:40123/v1",
        encryptedApiKey: cipher.encrypt("fixture-key").toString("base64"),
        models: ["phase6-fixture"],
      }],
    }));
    const store = new ModelCredentialStore(directory, cipher, vi.fn() as unknown as typeof fetch);
    await store.load(fallbacks);

    const raw = await readFile(path.join(directory, "model-credentials.json"), "utf8");
    expect(raw).not.toContain("fast-env-key");
    expect(raw).not.toContain("strong-env-key");
    expect(raw).not.toContain("phase6-fixture");
    expect(store.resolve("fast", fallbacks.fast)).toMatchObject({ status: "configured", apiKey: "fast-env-key" });
    expect(store.resolve("strong", fallbacks.strong)).toMatchObject({ status: "configured", apiKey: "strong-env-key" });
    await expect(readFile(path.join(directory, "api-connections.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(path.join(directory, "model-credentials.json"))).mode & 0o777).toBe(0o600);
  });

  it("tests and saves only the fixed model assigned to the selected tier", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hammercode-models-"));
    directories.push(directory);
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://relay.example/v1/models");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer replacement-key" });
      return new Response(JSON.stringify({ data: [{ id: "deepseek-v4-flash" }] }), { status: 200 });
    }) as typeof fetch;
    const store = new ModelCredentialStore(directory, cipher, fetchMock);
    await store.load({ ...fallbacks, fast: { ...fallbacks.fast, apiKey: "" } });
    const result = await store.save({
      tier: "fast",
      apiBaseUrl: "https://relay.example/v1",
      apiKey: "replacement-key",
    }, fallbacks.fast);
    expect(result).toMatchObject({ tier: "fast", model: "deepseek-v4-flash", status: "connected" });
    expect(store.resolve("fast", fallbacks.fast)).toMatchObject({
      apiBaseUrl: "https://relay.example/v1",
      apiKey: "replacement-key",
      status: "connected",
    });
  });

  it("rejects authentication, incompatible models and unavailable secure storage", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hammercode-models-"));
    directories.push(directory);
    const unauthorized = new ModelCredentialStore(
      directory,
      cipher,
      vi.fn(async () => new Response("unauthorized", { status: 401 })) as typeof fetch,
    );
    await unauthorized.load({ ...fallbacks, fast: { ...fallbacks.fast, apiKey: "" } });
    await expect(unauthorized.test({ tier: "fast", apiBaseUrl: "https://relay.example/v1", apiKey: "bad" }, fallbacks.fast))
      .rejects.toMatchObject({ code: "API_AUTH_FAILED" });

    const wrongModel = new ModelCredentialStore(
      directory,
      cipher,
      vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "other-model" }] }), { status: 200 })) as typeof fetch,
    );
    await wrongModel.load(fallbacks);
    await expect(wrongModel.test({ tier: "fast", apiBaseUrl: "https://relay.example/v1", apiKey: "bad" }, fallbacks.fast))
      .rejects.toMatchObject({ code: "MODEL_NOT_AVAILABLE" });

    const unavailable = new ModelCredentialStore(directory, { ...cipher, isAvailable: () => false });
    await unavailable.load(fallbacks);
    await expect(unavailable.save({ tier: "fast", apiBaseUrl: fallbacks.fast.apiBaseUrl }, fallbacks.fast))
      .rejects.toMatchObject({ code: "SECURE_STORAGE_UNAVAILABLE" });
  });
});

