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

function corsHeaders(origin: string | undefined): Record<string, string> {
  const allowed = config.allowedOrigins;
  const value = allowed.length === 0 ? "*" : origin && allowed.includes(origin) ? origin : "";
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
    return { status: 502, body: { error_code: error.code, message: error.message } };
  }

  return { status: 500, body: { error_code: "unknown", message: "The quote could not be created." } };
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

  const work = handleQuote(body);
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
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  response.end(html);
}

/** The install handshake: /auth/install sends the owner to Shopify, /auth/callback receives the answer. */
async function install(path: string, query: URLSearchParams, response: ServerResponse): Promise<boolean> {
  if (path === "/auth/install") {
    response.writeHead(302, { Location: authorizeUrl(), "Cache-Control": "no-store" });
    response.end();
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

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log("service_stopping", { signal });
    server.close(() => {
      void flushLog().then(() => process.exit(0));
    });
  });
}
