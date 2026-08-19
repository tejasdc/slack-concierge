import { expect, test } from "bun:test";
import { createCaptureEdgeHandler } from "../../cloudflare/capture-worker/src/index";

const environment = { ORIGIN_BASE_URL: "https://95-217-119-40.sslip.io" };

test("the readable capture hostname forwards only exact Pebble and health routes", async () => {
  const upstream: Request[] = [];
  const handler = createCaptureEdgeHandler(async (request) => {
    upstream.push(request);
    return Response.json({ ok: true }, { status: 202 });
  });

  const pebble = await handler(new Request("https://capture.tejas.nyc/pebble", {
    method: "POST",
    headers: { authorization: "Bearer secret", "content-type": "text/plain" },
    body: "transcript",
  }), environment);
  expect(pebble.status).toBe(202);
  expect(upstream[0].url).toBe("https://95-217-119-40.sslip.io/pebble");
  expect(upstream[0].headers.get("authorization")).toBe("Bearer secret");
  expect(await upstream[0].text()).toBe("transcript");

  expect((await handler(new Request("https://capture.tejas.nyc/health"), environment)).status).toBe(202);
  expect(upstream[1].url).toBe("https://95-217-119-40.sslip.io/health");

  for (const url of [
    "https://capture.tejas.nyc/audio",
    "https://capture.tejas.nyc/pebble/",
    "https://capture.tejas.nyc/%70ebble",
    "https://capture.tejas.nyc/pebble?debug=1",
  ]) {
    expect((await handler(new Request(url, { method: "POST" }), environment)).status).toBe(404);
  }
  expect(upstream).toHaveLength(2);
});

test("the edge rejects wrong methods before contacting the origin", async () => {
  let upstreamCalls = 0;
  const handler = createCaptureEdgeHandler(async () => {
    upstreamCalls += 1;
    return new Response("unexpected");
  });
  const pebbleGet = await handler(new Request("https://capture.tejas.nyc/pebble"), environment);
  expect(pebbleGet.status).toBe(405);
  expect(pebbleGet.headers.get("allow")).toBe("POST");
  const healthPost = await handler(new Request("https://capture.tejas.nyc/health", { method: "POST" }), environment);
  expect(healthPost.status).toBe(405);
  expect(healthPost.headers.get("allow")).toBe("GET");
  expect(upstreamCalls).toBe(0);
});
