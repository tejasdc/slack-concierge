import { describe, expect, test } from "bun:test";
import {
  MAX_PROVIDER_RESPONSE_BYTES,
  ProviderCredentialAdapter,
} from "../../../deployment-control/kernel/provider-adapter";

const incidentId = "11111111-1111-4111-8111-111111111111";
const capability = "a".repeat(43);

describe("deployment repair provider credential adapter", () => {
  test("injects only the existing provider authority after exact incident capability validation", async () => {
    const forwarded: Request[] = [];
    const adapter = new ProviderCredentialAdapter({
      now: () => 1_000,
      readCredential: () => ({ accessToken: "secret-access-token-value-that-is-long", accountId: "account-123" }),
      fetchUpstream: async (request) => {
        forwarded.push(request);
        return new Response("event: done\n\n", { headers: { "content-type": "text/event-stream", "set-cookie": "blocked" } });
      },
    });
    adapter.register({ incidentId, workerKind: "repair", capability, expiresAtMs: 2_000 });
    const response = await adapter.handle(new Request(
      `http://127.0.0.1/incidents/${incidentId}/repair/responses`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${capability}`,
          "chatgpt-account-id": "caller-override",
          cookie: "caller-cookie",
          "x-codex-turn-metadata": "bounded-metadata",
        },
        body: JSON.stringify({ model: "gpt-5.6-terra", input: [] }),
      },
    ));
    expect(response.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(forwarded[0].headers.get("authorization")).toBe("Bearer secret-access-token-value-that-is-long");
    expect(forwarded[0].headers.get("chatgpt-account-id")).toBe("account-123");
    expect(forwarded[0].headers.get("cookie")).toBeNull();
    expect(forwarded[0].headers.get("x-codex-turn-metadata")).toBe("bounded-metadata");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("rejects wrong roles, capabilities, query strings, expiry drift, and changed registrations", async () => {
    let now = 1_000;
    const adapter = new ProviderCredentialAdapter({
      now: () => now,
      readCredential: () => ({ accessToken: "secret-access-token-value-that-is-long", accountId: "account-123" }),
      fetchUpstream: async () => new Response("unexpected"),
    });
    adapter.register({ incidentId, workerKind: "review", capability, expiresAtMs: 2_000 });
    expect(() => adapter.register({
      incidentId,
      workerKind: "review",
      capability: "b".repeat(43),
      expiresAtMs: 2_000,
    })).toThrow("changed");
    const request = (suffix: string, token = capability) => new Request(
      `http://127.0.0.1/incidents/${incidentId}/${suffix}`,
      { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" },
    );
    expect((await adapter.handle(request("repair/responses"))).status).toBe(401);
    expect((await adapter.handle(request("review/responses?retry=1"))).status).toBe(404);
    expect((await adapter.handle(request("review/responses", "b".repeat(43)))).status).toBe(401);
    adapter.register({
      incidentId,
      workerKind: "review",
      capability: "b".repeat(43),
      expiresAtMs: 2_000,
      replace: true,
    });
    expect((await adapter.handle(request("review/responses"))).status).toBe(401);
    expect((await adapter.handle(request("review/responses", "b".repeat(43)))).status).toBe(200);
    now = 2_001;
    expect((await adapter.handle(request("review/responses", "b".repeat(43)))).status).toBe(401);
  });

  test("rejects declared and streamed upstream responses above the fixed response bound", async () => {
    let responseKind: "declared" | "streamed" = "declared";
    const adapter = new ProviderCredentialAdapter({
      now: () => 1_000,
      readCredential: () => ({ accessToken: "secret-access-token-value-that-is-long", accountId: "account-123" }),
      fetchUpstream: async () => responseKind === "declared"
        ? new Response("ignored", { headers: { "content-length": String(MAX_PROVIDER_RESPONSE_BYTES + 1) } })
        : new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(MAX_PROVIDER_RESPONSE_BYTES));
              controller.enqueue(new Uint8Array(1));
              controller.close();
            },
          })),
    });
    adapter.register({ incidentId, workerKind: "repair", capability, expiresAtMs: 2_000 });
    const request = () => new Request(
      `http://127.0.0.1/incidents/${incidentId}/repair/responses`,
      { method: "POST", headers: { authorization: `Bearer ${capability}` }, body: "{}" },
    );

    const declared = await adapter.handle(request());
    expect(declared.status).toBe(502);
    expect(await declared.text()).toContain("too large");

    responseKind = "streamed";
    const streamed = await adapter.handle(request());
    await expect(streamed.arrayBuffer()).rejects.toThrow("exceeded the adapter limit");
  });

  test("cancels a chunked request as soon as it crosses the fixed request bound", async () => {
    let pulls = 0;
    let cancelled = false;
    let upstreamCalls = 0;
    const adapter = new ProviderCredentialAdapter({
      now: () => 1_000,
      readCredential: () => ({ accessToken: "secret-access-token-value-that-is-long", accountId: "account-123" }),
      fetchUpstream: async () => {
        upstreamCalls += 1;
        return new Response("unexpected");
      },
    });
    adapter.register({ incidentId, workerKind: "repair", capability, expiresAtMs: 2_000 });
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = await adapter.handle(new Request(
      `http://127.0.0.1/incidents/${incidentId}/repair/responses`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${capability}` },
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" },
    ));
    expect(response.status).toBe(413);
    expect(pulls).toBe(5);
    expect(cancelled).toBeTrue();
    expect(upstreamCalls).toBe(0);
  });
});
