/**
 * The HTTP surface: two endpoints the quiz already knows how to call.
 *
 * POST /api/quiz/submissions turns a quote request into a draft order and an email.
 * POST /api/quiz/match answers with nothing on purpose, because the quiz keeps its own
 * ranking when the service does not override it, and a 404 there would break the kits screen.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { config } from "./config.ts";
import { log, flushLog } from "./log.ts";
import { handleQuote, RequestError, type QuoteResult } from "./quote.ts";
import { authorizeUrl, completeInstall, InstallError } from "./oauth.ts";
import { hasInstalledToken, shopName, ShopifyError } from "./shopify.ts";

/** Bigger than any quiz payload, small enough that a stray upload cannot fill memory. */
const MAX_BODY_BYTES = 64 * 1024;

/** Repeats of one attempt share an answer instead of creating a second draft order. */
const inFlight = new Map<string, Promise<QuoteResult>>();
const MAX_KEYS = 500;

function remember(key: string, result: Promise<QuoteResult>): void {
  inFlight.set(key, result);

  if (inFlight.size > MAX_KEYS) {
    const oldest = inFlight.keys().next();
    if (!oldest.done) inFlight.delete(oldest.value);
  }
}

/** An entry such as https://*.shopifypreview.com covers theme previews, whose subdomain changes every time. */
const allowedOriginPatterns = config.allowedOrigins.map(
  (entry) => new RegExp(`^${entry.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[a-z0-9-]+")}$`, "i")
);

function originAllowed(origin: string): boolean {
  return allowedOriginPatterns.some((pattern) => pattern.test(origin));
}

function corsHeaders(origin: string | undefined): Record<string, string> {
  const allowed = config.allowedOrigins;
  const value = allowed.length === 0 ? "*" : origin && originAllowed(origin) ? origin : "";
  if (!value) return {};

  return {
    "Access-Control-Allow-Origin": value,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, Idempotency-Key, x-quote-token",
    "Access-Control-Max-Age": "86400",
    ...(allowed.length === 0 ? {} : { Vary: "Origin" }),
  };
}

function send(response: ServerResponse, status: number, body: unknown, headers: Record<string, string>): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload), ...headers });
  response.end(payload);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new RequestError("payload_too_large", 413, "The request body is too large.");
    chunks.push(chunk as Buffer);
  }

  if (size === 0) return null;

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestError("invalid_json", 400, "The request body is not valid JSON.");
  }
}

function failure(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof RequestError) {
    return {
      status: error.status,
      body: { error_code: error.code, message: error.message, ...(Object.keys(error.fieldErrors).length > 0 ? { field_errors: error.fieldErrors } : {}) },
    };
  }

  if (error instanceof ShopifyError) {
    // A kit Shopify will not put on an order is the customer's problem to solve, by choosing
    // another one; retrying the same request would fail the same way for ever.
    if (error.code === "draft_order_rejected" || error.code === "draft_order_without_invoice") {
      return {
        status: 422,
        body: {
          error_code: error.code,
          message: "This kit cannot be ordered right now.",
          field_errors: { selected_variant_id: "This kit cannot be ordered right now. Please choose another kit." },
        },
      };
    }

    // Shopify's own wording names scopes, fields and throttle state, and the credentials error
    // even names the install URL. The caller gets the code; the detail stays in the log.
    return { status: 502, body: { error_code: error.code, message: "The quote could not be created." } };
  }

  return { status: 500, body: { error_code: "unknown", message: "The quote could not be created." } };
}

/**
 * What the storefront is allowed to ask for, and how often.
 *
 * The quiz posts from a browser with no credentials of its own, so the two things that can be
 * checked are where the request says it comes from and how many have arrived lately. Neither
 * stops a determined attacker, but together they keep the endpoint from being a free draft
 * order and free mail sender for anyone who finds the URL.
 */
const RATE_WINDOW_MS = 10 * 60 * 1000;
const seen = new Map<string, number[]>();

function callerKey(request: IncomingMessage): string {
  const forwarded = String(request.headers["x-forwarded-for"] || "").split(",")[0]?.trim();
  return forwarded || request.socket.remoteAddress || "unknown";
}

/** @returns Whether this caller is still within its allowance. */
function withinRate(key: string): boolean {
  const now = Date.now();
  const recent = (seen.get(key) ?? []).filter((at) => now - at < RATE_WINDOW_MS);

  if (recent.length >= config.rateLimitPerWindow) {
    seen.set(key, recent);
    return false;
  }

  recent.push(now);
  seen.set(key, recent);

  // Callers that have gone quiet are dropped, so the map cannot grow without end.
  if (seen.size > 5000) {
    for (const [other, times] of seen) {
      if (times.every((at) => now - at >= RATE_WINDOW_MS)) seen.delete(other);
    }
  }

  return true;
}

async function submissions(request: IncomingMessage, response: ServerResponse, headers: Record<string, string>): Promise<void> {
  const body = await readJson(request);
  const key = String(request.headers["idempotency-key"] || "");

  const pending = key ? inFlight.get(key) : undefined;
  if (pending) {
    log("submission_repeated", { key });
    send(response, 200, await pending, headers);
    return;
  }

  // The key also tags the draft order, so a retry after an unclear answer finds the quote
  // Shopify already created instead of creating a second one.
  const work = handleQuote(body, key);
  if (key) remember(key, work);

  try {
    send(response, 201, await work, headers);
  } catch (error) {
    // A failed attempt must be retryable, so its key is released.
    if (key) inFlight.delete(key);
    throw error;
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] as string);
}

function page(response: ServerResponse, status: number, title: string, body: string): void {
  const html = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><body style="font:16px/1.5 system-ui;max-width:40rem;margin:3rem auto;padding:0 1rem"><h1>${escapeHtml(title)}</h1>${body}`;
  // The success page shows an Admin API token; no referrer should carry the URL onwards.
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  response.end(html);
}

/** The install handshake: /auth/install sends the owner to Shopify, /auth/callback receives the answer. */
async function install(path: string, query: URLSearchParams, response: ServerResponse): Promise<boolean> {
  if (path === "/auth/install") {
    try {
      response.writeHead(302, { Location: authorizeUrl(), "Cache-Control": "no-store" });
      response.end();
    } catch (error) {
      // Missing client credentials belong on the install page, not in the quote endpoint's error shape.
      const message = error instanceof InstallError ? error.message : "The install could not be started.";
      page(response, 400, "Install unavailable", `<p>${escapeHtml(message)}</p>`);
    }
    return true;
  }

  if (path !== "/auth/callback") return false;

  try {
    const { token, scope } = await completeInstall(query);
    log("app_installed", { shop: config.shopify.shop, scope });
    page(response, 200, "Installed on " + config.shopify.shop, `
      <p>Quotes work from now on. To keep working after a restart, save this token in Railway as <code>SHOPIFY_ADMIN_TOKEN</code> and deploy:</p>
      <p><code style="word-break:break-all;user-select:all">${escapeHtml(token)}</code></p>
      <p>Granted scopes: <code>${escapeHtml(scope)}</code></p>`);
  } catch (error) {
    const message = error instanceof InstallError ? error.message : "The install could not be completed.";
    log("app_install_failed", { message: String(error) });
    page(response, 400, "Install failed", `<p>${escapeHtml(message)}</p><p><a href="/auth/install">Try again</a></p>`);
  }

  return true;
}

const server = createServer((request, response) => {
  const headers = corsHeaders(request.headers.origin);
  const [path = "/", search = ""] = (request.url || "/").split("?");

  void (async () => {
    const started = Date.now();

    try {
      if (request.method === "OPTIONS") {
        response.writeHead(204, headers);
        response.end();
        return;
      }

      if (request.method === "GET" && path === "/health") {
        send(response, 200, { ok: true, shop: config.shopify.shop, installed: hasInstalledToken() }, headers);
        return;
      }

      if (request.method === "GET" && (await install(path, new URLSearchParams(search), response))) return;

      if (config.apiToken && request.headers["x-quote-token"] !== config.apiToken) {
        send(response, 401, { error_code: "unauthorized", message: "Wrong or missing token." }, headers);
        return;
      }

      // CORS only decides what a browser may read; the work happens either way. So an origin
      // that is not on the list is turned away here, before a draft order or an email exists.
      if (config.allowedOrigins.length > 0 && Object.keys(headers).length === 0) {
        log("origin_refused", { path, origin: String(request.headers.origin || "") });
        send(response, 403, { error_code: "origin_not_allowed", message: "This service does not answer that origin." }, {});
        return;
      }

      if (request.method === "POST" && path === "/api/quiz/submissions" && !withinRate(callerKey(request))) {
        log("rate_limited", { caller: callerKey(request) });
        send(response, 429, { error_code: "too_many_requests", message: "Too many quote requests. Please try again later." }, headers);
        return;
      }

      if (request.method === "POST" && path === "/api/quiz/match") {
        // Nothing to add: the quiz keeps the ranking it worked out in the browser.
        send(response, 200, {}, headers);
        return;
      }

      if (request.method === "POST" && path === "/api/quiz/submissions") {
        await submissions(request, response, headers);
        log("submission_handled", { ms: Date.now() - started });
        return;
      }

      send(response, 404, { error_code: "not_found", message: `No route for ${request.method} ${path}.` }, headers);
    } catch (error) {
      const { status, body } = failure(error);
      log("request_failed", { path, status, error_code: body.error_code, message: String(error), ms: Date.now() - started });
      if (!response.headersSent) send(response, status, body, headers);
      else response.end();
    }
  })();
});

server.listen(config.port, () => {
  log("service_started", { port: config.port, shop: config.shopify.shop, apiVersion: config.shopify.apiVersion });

  // Proves the Shopify credentials at boot, so a wrong secret shows in the deploy log and not on a customer's quote.
  shopName().then(
    (name) => log("shopify_connected", { shop: config.shopify.shop, name, auth: "token" in config.shopify.auth ? "admin_token" : "client_credentials" }),
    (error) => log("shopify_connection_failed", { shop: config.shopify.shop, code: error instanceof ShopifyError ? error.code : "unknown", message: String(error) })
  );
});

// A crash that repeats would exhaust Railway's restart budget and leave the service down, so
// the reason is written down before the process goes.
for (const event of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(event, (error: unknown) => {
    log("service_crashed", { event, message: String(error) });
    void flushLog().finally(() => process.exit(1));
  });
}

let stopping = false;

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    log("service_stopping", { signal });

    server.close(() => {
      void flushLog().finally(() => process.exit(0));
    });

    // Keep-alive sockets would otherwise hold close() open for their idle timeout, and a stuck
    // request would hold it until the platform kills the process mid-quote.
    server.closeIdleConnections();
    setTimeout(() => {
      server.closeAllConnections();
      void flushLog().finally(() => process.exit(0));
    }, 10000).unref();
  });
}
