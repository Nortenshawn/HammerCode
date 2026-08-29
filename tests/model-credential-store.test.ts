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

async function directory(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), "hammercode-models-"));
  directories.push(value);
  return value;
}

describe("model credential store", () => {
  it("normalizes safe endpoints and rejects unsafe remote URLs", () => {
    expect(normalizeApiBaseUrl("https://relay.example/v1/chat/completions")).toBe("https://relay.example/v1");
    expect(normalizeApiBaseUrl("http://localhost:8000/v1/models")).toBe("http://localhost:8000/v1");
    expect(() => normalizeApiBaseUrl("http://relay.example/v1")).toThrow();
    expect(() => normalizeApiBaseUrl("https://key@relay.example/v1")).toThrow();
  });

  it("migrates fixed slots, encrypts env fallbacks and keeps obsolete demo data deleted", async () => {
    const root = await directory();
    await writeFile(path.join(root, "api-connections.json"), JSON.stringify({
      version: 1,
      connections: [{
        apiBaseUrl: "http://127.0.0.1:40123/v1",
        encryptedApiKey: cipher.encrypt("fixture-key").toString("base64"),
        models: ["phase6-fixture"],
      }],
    }));
    const store = new ModelCredentialStore(root, cipher, vi.fn() as unknown as typeof fetch);
    await store.load(fallbacks);

    const raw = await readFile(path.join(root, "model-credentials.json"), "utf8");
    expect(raw).toContain('"version": 2');
    expect(raw).not.toContain("fast-env-key");
    expect(raw).not.toContain("strong-env-key");
    expect(raw).not.toContain("phase6-fixture");
    expect(store.resolve("builtin:fast", fallbacks)).toMatchObject({
      name: "Fast",
      tier: "fast",
      status: "configured",
      apiKey: "fast-env-key",
    });
    expect(store.resolve("builtin:strong", fallbacks)).toMatchObject({ tier: "strong", apiKey: "strong-env-key" });
    await expect(readFile(path.join(root, "api-connections.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(path.join(root, "model-credentials.json"))).mode & 0o777).toBe(0o600);
  });

  it("discovers models, adds a connection, renames defaults and deletes only custom entries", async () => {
    const root = await directory();
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://relay.example/v1/models");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer replacement-key" });
      return new Response(JSON.stringify({ data: [{ id: "model-b" }, { id: "model-a" }] }), { status: 200 });
    }) as typeof fetch;
    const store = new ModelCredentialStore(root, cipher, fetchMock);
    await store.load(fallbacks);

    const probe = await store.test({
      apiBaseUrl: "https://relay.example/v1",
      apiKey: "replacement-key",
    }, fallbacks);
    expect(probe.models).toEqual(["model-a", "model-b"]);

    const custom = await store.save({
      name: "演示中转站",
      tier: "fast",
      model: "model-b",
      apiBaseUrl: "https://relay.example/v1",
      apiKey: "replacement-key",
    }, fallbacks);
    expect(custom).toMatchObject({ kind: "custom", name: "演示中转站", model: "model-b", tier: "fast" });
    expect(custom.ref).toMatch(/^connection:/);
    expect(store.resolve(custom.ref, fallbacks)).toMatchObject({ apiKey: "replacement-key", model: "model-b" });

    expect(await store.rename("builtin:fast", "日常模型", fallbacks)).toMatchObject({ name: "日常模型" });
    await store.delete(custom.id);
    expect(store.resolve(custom.ref, fallbacks)).toBeNull();
    await expect(store.delete("builtin:fast")).rejects.toMatchObject({ code: "DEFAULT_MODEL_CONNECTION_REQUIRED" });
  });

  it("does not save failed probes or plaintext keys", async () => {
    const root = await directory();
    const unauthorized = new ModelCredentialStore(
      root,
      cipher,
      vi.fn(async () => new Response("unauthorized", { status: 401 })) as typeof fetch,
    );
    await unauthorized.load(fallbacks);
    await expect(unauthorized.test({ apiBaseUrl: "https://relay.example/v1", apiKey: "bad" }, fallbacks))
      .rejects.toMatchObject({ code: "API_AUTH_FAILED" });

    const wrongModel = new ModelCredentialStore(
      await directory(),
      cipher,
      vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "other-model" }] }), { status: 200 })) as typeof fetch,
    );
    await wrongModel.load(fallbacks);
    await expect(wrongModel.save({
      name: "invalid",
      tier: "fast",
      model: "missing-model",
      apiBaseUrl: "https://relay.example/v1",
      apiKey: "secret-key",
    }, fallbacks)).rejects.toMatchObject({ code: "MODEL_NOT_AVAILABLE" });
    expect(wrongModel.listPublic(fallbacks)).toHaveLength(2);

    const unavailable = new ModelCredentialStore(await directory(), { ...cipher, isAvailable: () => false });
    await unavailable.load(fallbacks);
    await expect(unavailable.save({
      connectionId: "builtin:fast",
      name: "Fast",
      tier: "fast",
      model: fallbacks.fast.model,
      apiBaseUrl: fallbacks.fast.apiBaseUrl,
    }, fallbacks)).rejects.toMatchObject({ code: "SECURE_STORAGE_UNAVAILABLE" });
  });
});
