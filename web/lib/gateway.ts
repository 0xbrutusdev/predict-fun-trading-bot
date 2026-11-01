import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

type Config = {
  url?: string;
  token?: string;
  key?: string;
  production?: boolean;
};
export const config = (): Config => ({
  url: process.env.BOT_API_URL,
  token: process.env.BOT_API_TOKEN,
  key: process.env.DASHBOARD_ACCESS_KEY,
  production: process.env.NODE_ENV === "production",
});
const cookieName = "predict_session";
const equal = (a: string, b: string) =>
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const sign = (text: string, key: string) =>
  createHmac("sha256", key).update(text).digest("hex");
export function session(key: string, now = Date.now()) {
  const exp = String(now + 8 * 3600_000);
  return `${exp}.${sign(exp, key)}`;
}
export function authenticated(req: Request, c: Config, now = Date.now()) {
  if (!c.key || c.key.length < 32) return false;
  const raw =
    req.headers
      .get("cookie")
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1) ?? "";
  const [exp, mac, extra] = raw.split(".");
  return (
    !extra &&
    /^\d+$/.test(exp ?? "") &&
    Number(exp) > now &&
    Number(exp) <= now + 8 * 3600_000 &&
    equal(mac ?? "", sign(exp, c.key))
  );
}
export function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}
const error = (code: string, status: number, requestId?: string) =>
  json({ error: { code, requestId } }, status);
export function sameOrigin(req: Request) {
  return (
    req.headers.get("origin") === new URL(req.url).origin &&
    req.headers.get("sec-fetch-site") !== "cross-site"
  );
}
async function limitedBody(req: Request) {
  if (!req.headers.get("content-type")?.startsWith("application/json"))
    throw new Error("content_type");
  const reader = req.body?.getReader();
  if (!reader) return "{}";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 262144) {
      await reader.cancel();
      throw new Error("body_too_large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
export async function login(req: Request, c = config()) {
  if (!sameOrigin(req)) return error("origin_rejected", 403);
  if (!c.key || c.key.length < 32)
    return error("dashboard_not_configured", 503);
  try {
    const body = JSON.parse(await limitedBody(req));
    if (typeof body.key !== "string" || !equal(body.key, c.key))
      return error("invalid_access_key", 401);
    return json({ data: { authenticated: true } }, 200, {
      "Set-Cookie": `${cookieName}=${session(c.key)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${c.production ? "; Secure" : ""}`,
    });
  } catch {
    return error("invalid_request", 400);
  }
}
export function logout(req: Request, c = config()) {
  if (!sameOrigin(req)) return error("origin_rejected", 403);
  return json({ data: { authenticated: false } }, 200, {
    "Set-Cookie": `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${c.production ? "; Secure" : ""}`,
  });
}
// Explicit allowlist: never let a browser turn this into an arbitrary bearer-token proxy.
export function allowed(path: string, method: string) {
  if (method === "GET")
    return /^(status|observability|strategies|accounts|markets|markets\/discovery|events|accounts\/[\w:-]+(?:\/(strategies|features|positions|fills|pnl))?|markets\/[\w:-]+\/book)$/.test(
      path,
    );
  if (method === "POST") return path === "accounts" || path === "kill-switch";
  if (method === "PATCH") return /^accounts\/[\w:-]+$/.test(path);
  if (method === "PUT") return /^accounts\/[\w:-]+\/strategies$/.test(path);
  return false;
}
export async function proxy(
  req: Request,
  path: string,
  c = config(),
  fetcher: typeof fetch = fetch,
) {
  const requestId = randomUUID(),
    started = Date.now();
  if (!authenticated(req, c)) return error("unauthorized", 401, requestId);
  if (!allowed(path, req.method))
    return error("route_not_allowed", 404, requestId);
  if (req.method !== "GET" && !sameOrigin(req))
    return error("origin_rejected", 403, requestId);
  if (!c.url || !c.token || c.token.length < 32)
    return error("worker_not_configured", 503, requestId);
  let status = 502;
  try {
    const base = new URL(c.url);
    if (
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      base.pathname !== "/" ||
      !["http:", "https:"].includes(base.protocol) ||
      (c.production &&
        base.protocol !== "https:" &&
        !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname))
    )
      return error("invalid_worker_configuration", 503, requestId);
    const target = new URL(`/v1/${path}`, base);
    new URL(req.url).searchParams.forEach((v, k) => {
      if (k === "after" || k === "limit") target.searchParams.set(k, v);
    });
    let body: string | undefined;
    if (req.method !== "GET") {
      try {
        body = await limitedBody(req);
        JSON.parse(body);
      } catch {
        return error("invalid_request", 400, requestId);
      }
    }
    const upstream = await fetcher(target, {
      method: req.method,
      headers: {
        authorization: `Bearer ${c.token}`,
        "content-type": "application/json",
        "x-request-id": requestId,
      },
      body,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
    status = upstream.status;
    if (status >= 500) return error("worker_error", 502, requestId);
    const payload = await upstream.json();
    return json(payload, status, { "X-Request-Id": requestId });
  } catch {
    status = 502;
    return error("worker_unreachable", 502, requestId);
  } finally {
    console.info(
      JSON.stringify({
        event: "bot.gateway",
        requestId,
        method: req.method,
        path,
        status,
        durationMs: Date.now() - started,
      }),
    );
  }
}
