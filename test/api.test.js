import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../dist/app.js";
import { readConfig } from "../dist/config.js";

async function serve(t, upstream, env = {}) {
  const server = createApp(readConfig(env), upstream).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  return (path, options) => fetch(`http://127.0.0.1:${server.address().port}${path}`, options);
}

const products = [1, 2, 3, 4, 5, 6].map(id => ({
  id, title: id === 2 ? "Hiking BAG" : `Item ${id}`, category: id === 2 ? "bags" : "other",
  price: 12, image: "https://example.org/product.png", description: "Bag accessories",
  rating: { rate: id <= 2 ? 4 : 5, count: id === 5 ? 20 : 10 }
}));
const enquiry = { name: "Buyer", email: "buyer@example.org", message: "Is this in stock?", productId: 2 };
const mail = { ENQUIRY_TO: "sales@example.org", ENQUIRY_FROM: "app@example.org", RESEND_API_KEY: "test-only" };
const post = body => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("catalogue routes return the documented shapes, filters, and ranking", async t => {
  const get = await serve(t, async url => {
    switch (url) {
      case "https://fakestoreapi.com/products/categories": return Response.json(["bags", "other"]);
      case "https://fakestoreapi.com/products": return Response.json(products);
      case "https://fakestoreapi.com/products/2": return Response.json(products[1]);
      default: throw new Error("Unexpected upstream URL");
    }
  });
  for (const [path, expected] of [
    ["categories", ["bags", "other"]], ["products", products],
    ["products/2", products[1]], ["products?category=bags", [products[1]]],
    ["products/search?q=%20baG%20", [products[1]]], ["products/search?q=zzz", []],
    ["products/featured", [5, 3, 4, 6, 1].map(id => products[id - 1])]
  ]) {
    const res = await get(`/api/${path}`);
    assert.equal(res.status, 200, path);
    assert.deepEqual(await res.json(), expected, path);
  }
});

test("invalid parameters and invalid enquiry inputs are rejected before upstream calls", async t => {
  let calls = 0;
  const send = await serve(t, async () => { calls++; return Response.error(); }, mail);
  for (const path of ["0", "-1", "9007199254740992", "search", "search?q=+", "search?q=a&q=b"]) {
    assert.equal((await send(`/api/products/${path}`)).status, 400);
  }
  for (const [options, status] of [
    [post({ ...enquiry, email: "bad" }), 400], [post({ ...enquiry, to: "unexpected" }), 400],
    [{ ...post(enquiry), body: "{" }, 400], [post({ message: "x".repeat(33 * 1024) }), 413],
    [{ method: "POST", body: "not JSON" }, 415]
  ]) assert.equal((await send("/api/enquiries", options)).status, status);
  assert.equal(calls, 0);
});

test("detail distinguishes missing products from upstream failures", async t => {
  for (const [response, status] of [
    [new Response(null, { status: 404 }), 404], [new Response(""), 404], [Response.json(null), 404],
    [Response.json(products[0]), 502], [new Response("oops"), 502], [Response.json({}), 502],
    [new Response(null, { status: 503 }), 502]
  ]) {
    const get = await serve(t, async () => response);
    assert.equal((await get("/api/products/3")).status, status);
  }
});

test("upstream abort produces a gateway timeout", async t => {
  const get = await serve(t, (_url, { signal }) => new Promise((_resolve, reject) =>
    signal.addEventListener("abort", () => reject(signal.reason), { once: true })
  ), { UPSTREAM_TIMEOUT_MS: "25" });
  assert.equal((await get("/api/products")).status, 504);
});

test("enquiries fail closed without configuration, on rejection, and without a receipt", async t => {
  const disabled = await serve(t, () => { throw new Error("unexpected call"); });
  assert.equal((await disabled("/api/enquiries", post(enquiry))).status, 503);
  for (const result of [new Response(null, { status: 403 }), Response.json({})]) {
    const send = await serve(t, () => result, mail);
    assert.equal((await send("/api/enquiries", post(enquiry))).status, 502);
  }
});

test("provider acceptance is not reported as delivery", async t => {
  const id = "4b67da19-bc3b-4db3-a669-235479c07c51";
  const send = await serve(t, async (url, options) => {
    assert.equal(url, "https://api.resend.com/emails");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Authorization, `Bearer ${mail.RESEND_API_KEY}`);
    const data = JSON.parse(options.body);
    assert.deepEqual(data.to, [mail.ENQUIRY_TO]);
    assert.equal(data.from, mail.ENQUIRY_FROM);
    assert.equal(data.reply_to, enquiry.email);
    assert.ok(data.text.includes(enquiry.message));
    assert.ok(data.text.includes("Product ID: 2"));
    return Response.json({ id });
  }, mail);
  const res = await send("/api/enquiries", post(enquiry));
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { status: "accepted", id });
});

test("enquiry rate limit stops the sixth attempt without blocking catalogue access", async t => {
  const send = await serve(t, () => Response.json(products));
  for (let i = 0; i < 5; i++) assert.equal((await send("/api/enquiries", post(enquiry))).status, 503);
  const blocked = await send("/api/enquiries", post(enquiry));
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("retry-after")) > 0);
  assert.equal((await send("/api/products")).status, 200);
});

test("invalid startup settings fail explicitly", () => {
  assert.throws(() => readConfig({ ENQUIRY_TO: mail.ENQUIRY_TO }), /all three/);
  assert.throws(() => readConfig({ PORT: "70000" }), /PORT/);
  assert.throws(() => readConfig({ UPSTREAM_TIMEOUT_MS: "0" }), /UPSTREAM_TIMEOUT_MS/);
});

test("wildcard CORS allows any browser origin without credentials", async t => {
  const get = await serve(t, () => Response.json(products));
  for (const origin of ["http://localhost:5173", "https://client.example.org"]) {
    const res = await get("/api/products", { headers: { Origin: origin } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.equal(res.headers.get("access-control-allow-credentials"), null);
    assert.deepEqual(await res.json(), products);
  }
});

test("JSON enquiry preflights do not call upstream or consume enquiry attempts", async t => {
  let calls = 0;
  const send = await serve(t, () => { calls++; return Response.error(); });
  for (let i = 0; i < 6; i++) {
    const res = await send("/api/enquiries", {
      method: "OPTIONS",
      headers: {
        Origin: "https://client.example.org",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type"
      }
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.ok(res.headers.get("access-control-allow-methods").split(",").includes("POST"));
    assert.equal(res.headers.get("access-control-allow-headers").toLowerCase(), "content-type");
    assert.equal(await res.text(), "");
  }
  assert.equal((await send("/api/enquiries", post(enquiry))).status, 503);
  assert.equal(calls, 0);
});

test("CORS headers remain present on validation, upstream, and rate-limit errors", async t => {
  const send = await serve(t, () => new Response(null, { status: 403 }));
  const headers = { Origin: "https://client.example.org" };
  for (const [path, status] of [["/api/products/0", 400], ["/api/products", 502]]) {
    const res = await send(path, { headers });
    assert.equal(res.status, status);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
  }
  for (let i = 0; i < 6; i++) {
    const options = post(enquiry);
    const res = await send("/api/enquiries", { ...options, headers: { ...options.headers, ...headers } });
    assert.equal(res.status, i === 5 ? 429 : 503);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    if (i === 5) {
      assert.ok(res.headers.get("access-control-expose-headers").split(",").includes("Retry-After"));
      assert.ok(Number(res.headers.get("retry-after")) > 0);
    }
  }
});
