import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { handleRequest } from "../src/index.mjs";

function originStub(responses) {
  const requests = [];
  const fetcher = async (request) => {
    requests.push(request);
    assert.ok(responses.length, `unexpected origin fetch: ${request.url}`);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { requests, fetcher };
}

for (const [hostname, site] of [["wow.eklib.io", "wow"], ["note.eklib.io", "note"]]) {
  test(`${hostname}: GET maps only to its own site and keeps query`, async () => {
    const stub = originStub([new Response(site, { headers: { "content-type": "text/html", etag: '"site"' } })]);
    const response = await handleRequest(new Request(`https://${hostname}/guides/?q=%E7%AD%86%E8%A8%98&x=1&x=2`), stub.fetcher);
    assert.equal(stub.requests[0].url, `https://eklib.io/_sites/${site}/guides/?q=%E7%AD%86%E8%A8%98&x=1&x=2`);
    assert.equal(stub.requests[0].method, "GET");
    assert.equal(stub.requests[0].redirect, "manual");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("etag"), '"site"');
    assert.equal(await response.text(), site);
  });

  test(`${hostname}: HEAD has no response body`, async () => {
    const stub = originStub([new Response(null, { headers: { "content-type": "text/html", "content-length": "400" } })]);
    const response = await handleRequest(new Request(`https://${hostname}/`, { method: "HEAD" }), stub.fetcher);
    assert.equal(stub.requests[0].method, "HEAD");
    assert.equal(response.status, 200);
    assert.equal(response.body, null);
    assert.equal(response.headers.get("content-length"), "400");
  });

  test(`${hostname}: missing resource uses that site's custom 404`, async () => {
    const stub = originStub([
      new Response("shared origin error", { status: 404 }),
      new Response(`${site} custom error`, { headers: { "content-type": "text/html" } }),
    ]);
    const response = await handleRequest(new Request(`https://${hostname}/missing?x=1`, { headers: { range: "bytes=1-2", "if-none-match": '"old"' } }), stub.fetcher);
    assert.equal(response.status, 404);
    assert.equal(await response.text(), `${site} custom error`);
    assert.equal(stub.requests[1].url, `https://eklib.io/_sites/${site}/404.html`);
    assert.equal(stub.requests[1].headers.has("range"), false);
    assert.equal(stub.requests[1].headers.has("if-none-match"), false);
  });

  test(`${hostname}: HEAD 404 preserves status without a body`, async () => {
    const stub = originStub([new Response(null, { status: 404 }), new Response(null, { headers: { "content-type": "text/html" } })]);
    const response = await handleRequest(new Request(`https://${hostname}/missing`, { method: "HEAD" }), stub.fetcher);
    assert.equal(response.status, 404);
    assert.equal(response.body, null);
    assert.ok(stub.requests.every(request => request.method === "HEAD"));
  });

  for (const location of [`https://eklib.io/_sites/${site}/guides/?x=2#step`, `/_sites/${site}/guides/?x=2#step`, "guides/?x=2#step"]) {
    test(`${hostname}: rewrites directory redirect ${location}`, async () => {
      const stub = originStub([new Response(null, { status: 301, headers: { location } })]);
      const response = await handleRequest(new Request(`https://${hostname}/`), stub.fetcher);
      assert.equal(response.status, 301);
      assert.equal(response.headers.get("location"), `https://${hostname}/guides/?x=2#step`);
      assert.equal(response.headers.get("location").includes("_sites"), false);
    });
  }
}

test("unknown host and apex are not handled by this router", async () => {
  for (const hostname of ["eklib.io", "www.eklib.io", "other.eklib.io", "eklib-hostname-router.workers.dev"]) {
    const stub = originStub([]);
    const response = await handleRequest(new Request(`https://${hostname}/`), stub.fetcher);
    assert.equal(response.status, 404);
    assert.equal(stub.requests.length, 0);
    assert.doesNotMatch(await response.text(), /wow\.eklib|note\.eklib/);
  }
});

test("only GET and HEAD are allowed", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const stub = originStub([]);
    const response = await handleRequest(new Request("https://wow.eklib.io/", { method }), stub.fetcher);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET, HEAD");
    assert.equal(stub.requests.length, 0);
  }
});

test("http and index URLs canonicalize without fetching or exposing origin prefix", async () => {
  for (const [input, output] of [
    ["http://wow.eklib.io/guides/?x=1", "https://wow.eklib.io/guides/?x=1"],
    ["https://wow.eklib.io/index.html?x=1", "https://wow.eklib.io/?x=1"],
    ["https://note.eklib.io/guides/index.html?x=1", "https://note.eklib.io/guides/?x=1"],
  ]) {
    const stub = originStub([]);
    const response = await handleRequest(new Request(input), stub.fetcher);
    assert.equal(response.status, 308);
    assert.equal(response.headers.get("location"), output);
    assert.equal(stub.requests.length, 0);
  }
});

test("origin index redirects use the public URL", async () => {
  const stub = originStub([new Response(null, { status: 302, headers: { location: "/_sites/wow/guides/index.html?q=1" } })]);
  const response = await handleRequest(new Request("https://wow.eklib.io/guide"), stub.fetcher);
  assert.equal(response.headers.get("location"), "https://wow.eklib.io/guides/?q=1");
});

test("direct, encoded and nested internal paths never reach the origin", async () => {
  for (const pathname of ["/_sites/note/", "/%5fsites/note/", "/%2f_sites/note/", "/%5c../note/", "/%252e%252e/note/", "/%252f_sites/note/", "/%GG/"]) {
    const stub = originStub([]);
    const response = await handleRequest(new Request(`https://wow.eklib.io${pathname}`), stub.fetcher);
    assert.equal(response.status, 404, pathname);
    assert.equal(stub.requests.length, 0, pathname);
  }
});

test("cross-site, root and external origin redirects are rejected", async () => {
  for (const location of ["/_sites/note/", "/", "/_sites/wow-other/", "https://note.eklib.io/", "https://example.com/", "https://user:password@eklib.io/_sites/wow/"]) {
    const stub = originStub([new Response(null, { status: 302, headers: { location } })]);
    const response = await handleRequest(new Request("https://wow.eklib.io/"), stub.fetcher);
    assert.equal(response.status, 502, location);
    assert.equal(response.headers.has("location"), false);
    assert.doesNotMatch(await response.text(), /_sites|note\.eklib|example\.com|password/);
  }
});

test("visitor credentials and identifying headers are not forwarded", async () => {
  const stub = originStub([new Response("ok", { headers: { "set-cookie": "origin=secret", link: '<https://eklib.io/_sites/note/>; rel="next"', "content-type": "text/plain" } })]);
  const request = new Request("https://wow.eklib.io/", { headers: {
    cookie: "session=secret", authorization: "Bearer secret", "proxy-authorization": "secret",
    "cf-access-jwt-assertion": "secret", referer: "https://note.eklib.io/", origin: "https://note.eklib.io",
    "x-forwarded-host": "note.eklib.io", host: "note.eklib.io", "if-none-match": '"fresh"', accept: "text/html",
  } });
  const response = await handleRequest(request, stub.fetcher);
  const headers = stub.requests[0].headers;
  for (const name of ["cookie", "authorization", "proxy-authorization", "cf-access-jwt-assertion", "referer", "origin", "x-forwarded-host", "host"]) {
    assert.equal(headers.has(name), false, name);
  }
  assert.equal(headers.get("if-none-match"), '"fresh"');
  assert.equal(headers.get("accept"), "text/html");
  assert.equal(stub.requests[0].url, "https://eklib.io/_sites/wow/");
  assert.equal(response.headers.has("set-cookie"), false);
  assert.equal(response.headers.has("link"), false);
});

test("conditional and partial responses keep their original semantics", async () => {
  const notModified = originStub([new Response(null, { status: 304, headers: { etag: '"match"' } })]);
  const response304 = await handleRequest(new Request("https://wow.eklib.io/assets/site.css"), notModified.fetcher);
  assert.equal(response304.status, 304);
  assert.equal(response304.body, null);
  assert.equal(response304.headers.get("etag"), '"match"');
  const partial = originStub([new Response("part", { status: 206, headers: { "content-range": "bytes 0-3/10" } })]);
  const response206 = await handleRequest(new Request("https://note.eklib.io/file.zip", { headers: { range: "bytes=0-3" } }), partial.fetcher);
  assert.equal(partial.requests[0].headers.get("range"), "bytes=0-3");
  assert.equal(response206.status, 206);
  assert.equal(response206.headers.get("content-range"), "bytes 0-3/10");
  assert.equal(await response206.text(), "part");
});

test("origin failures return a neutral error rather than origin HTML", async () => {
  for (const upstream of [new Response("root /_sites/note/", { status: 500 }), new Response("root /_sites/note/", { status: 403 }), new Error("https://eklib.io/_sites/note/private")]) {
    const stub = originStub([upstream]);
    const response = await handleRequest(new Request("https://wow.eklib.io/"), stub.fetcher);
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /_sites|eklib\.io|private/);
  }
});

test("missing or failed custom 404 uses only a site-local fallback", async () => {
  for (const failure of [new Response("origin root 404", { status: 404 }), new Error("origin down")]) {
    const stub = originStub([new Response("origin root 404", { status: 404 }), failure]);
    const response = await handleRequest(new Request("https://wow.eklib.io/not-here"), stub.fetcher);
    assert.equal(response.status, 404);
    const html = await response.text();
    assert.match(html, /WoW/);
    assert.doesNotMatch(html, /note\.eklib|_sites|origin root/);
  }
});

test("deployment config exposes only the two custom domains", async () => {
  const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.deepEqual(config.routes, [
    { pattern: "wow.eklib.io", custom_domain: true },
    { pattern: "note.eklib.io", custom_domain: true },
  ]);
});
