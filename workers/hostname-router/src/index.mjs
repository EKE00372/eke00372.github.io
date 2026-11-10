const ORIGIN = "https://eklib.io";
const ORIGIN_TIMEOUT_MS = 15_000;

const SITES = new Map([
  ["wow.eklib.io", { key: "wow", title: "WoW" }],
  ["note.eklib.io", { key: "note", title: "筆記" }],
]);

// Build a new request rather than forwarding cookies, credentials or the
// visitor's Referer/Origin headers to the shared static origin.
const REQUEST_HEADERS = [
  "accept", "accept-language", "if-none-match", "if-modified-since",
  "range", "if-range",
];

const RESPONSE_HEADERS = [
  "content-type", "content-length", "content-encoding", "content-disposition",
  "cache-control", "etag", "last-modified", "expires", "vary",
  "accept-ranges", "content-range", "content-security-policy",
  "strict-transport-security", "permissions-policy", "referrer-policy",
  "x-content-type-options", "x-frame-options",
];

function selectedHeaders(source, names) {
  const result = new Headers();
  for (const name of names) {
    if (source.has(name)) result.set(name, source.get(name));
  }
  return result;
}

function publicURL(hostname, pathname, search = "", hash = "") {
  const result = new URL(`https://${hostname}`);
  result.pathname = pathname;
  result.search = search;
  result.hash = hash;
  return result;
}

function originURL(site, pathname, search = "") {
  const result = new URL(ORIGIN);
  result.pathname = `/_sites/${site.key}${pathname}`;
  result.search = search;
  return result;
}

function validPublicPath(pathname) {
  for (const part of pathname.split("/")) {
    let decoded;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      return false;
    }
    if (decoded === "." || decoded === ".." || decoded.toLowerCase() === "_sites") return false;
    if (/[\/\\\u0000-\u001f\u007f]/.test(decoded)) return false;
    // Do not let an additional decoding layer turn a filename into a path.
    if (/%(?:2e|2f|5c|25)/i.test(decoded)) return false;
  }
  return true;
}

function plainResponse(request, status, message, extraHeaders = {}) {
  return new Response(request.method === "HEAD" ? null : message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...extraHeaders },
  });
}

function localNotFound(request, site) {
  const title = site?.title ?? "";
  const body = `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>找不到頁面${title ? ` | ${title}` : ""}</title><h1>找不到頁面</h1><p>這個網址目前沒有內容。</p>${site ? '<p><a href="/">回到首頁</a></p>' : ""}</html>`;
  return new Response(request.method === "HEAD" ? null : body, {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

async function discard(response) {
  if (response.body) await response.body.cancel().catch(() => {});
}

async function fetchOrigin(url, request, headers, fetcher) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ORIGIN_TIMEOUT_MS);
  try {
    return await fetcher(new Request(url, {
      method: request.method,
      headers,
      redirect: "manual",
      signal: controller.signal,
    }));
  } finally {
    clearTimeout(timeout);
  }
}

function proxyResponse(request, response, status = response.status) {
  const headers = selectedHeaders(response.headers, RESPONSE_HEADERS);
  if (status === 404) headers.set("cache-control", "public, max-age=60");
  const noBody = request.method === "HEAD" || status === 204 || status === 304;
  return new Response(noBody ? null : response.body, { status, headers });
}

async function siteNotFound(request, site, fetcher) {
  try {
    // Conditional/range headers belong to the missing resource, not 404.html.
    const response = await fetchOrigin(originURL(site, "/404.html"), request, new Headers(), fetcher);
    if (response.status === 200) return proxyResponse(request, response, 404);
    await discard(response);
  } catch {
    // A missing custom error page must never expose the shared origin's 404.
  }
  return localNotFound(request, site);
}

function rewrittenLocation(value, sourceURL, hostname, site) {
  let target;
  try {
    target = new URL(value, sourceURL);
  } catch {
    return null;
  }
  const prefix = `/_sites/${site.key}`;
  if (target.origin !== ORIGIN || target.username || target.password) return null;
  if (target.pathname !== prefix && !target.pathname.startsWith(`${prefix}/`)) return null;
  let pathname = target.pathname.slice(prefix.length) || "/";
  if (!validPublicPath(pathname)) return null;
  pathname = pathname.replace(/\/index\.html$/, "/");
  return publicURL(hostname, pathname, target.search, target.hash).href;
}

export async function handleRequest(request, fetcher = globalThis.fetch) {
  const url = new URL(request.url);
  const site = SITES.get(url.hostname);
  if (!site) return localNotFound(request);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return plainResponse(request, 405, "只支援 GET 與 HEAD。", { allow: "GET, HEAD" });
  }
  if (!validPublicPath(url.pathname)) return localNotFound(request, site);

  const pathname = url.pathname.replace(/\/index\.html$/, "/");
  if (url.protocol !== "https:" || pathname !== url.pathname) {
    return new Response(null, {
      status: 308,
      headers: { location: publicURL(url.hostname, pathname, url.search).href },
    });
  }

  const sourceURL = originURL(site, pathname, url.search);
  try {
    const response = await fetchOrigin(sourceURL, request, selectedHeaders(request.headers, REQUEST_HEADERS), fetcher);
    if (response.status === 404) {
      await discard(response);
      return siteNotFound(request, site, fetcher);
    }
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      const location = response.headers.get("location");
      const rewritten = location && rewrittenLocation(location, sourceURL, url.hostname, site);
      await discard(response);
      if (!rewritten) return plainResponse(request, 502, "網站暫時無法連線，請稍後再試。");
      return new Response(null, {
        status: response.status,
        headers: { location: rewritten },
      });
    }
    if ((response.status < 200 || response.status >= 300) && response.status !== 304) {
      await discard(response);
      return plainResponse(request, 502, "網站暫時無法連線，請稍後再試。");
    }
    return proxyResponse(request, response);
  } catch {
    return plainResponse(request, 502, "網站暫時無法連線，請稍後再試。");
  }
}

export default {
  fetch(request) {
    return handleRequest(request);
  },
};
