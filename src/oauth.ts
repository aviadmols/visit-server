/**
 * The install handshake for an app that lives outside the store's organization.
 *
 * Client credentials only work inside one organization. For a Partner app installed on a
 * client's store, the store owner approves the app once in admin, Shopify sends back a code,
 * and the code becomes a permanent token. The token is kept in memory and shown once, so it
 * can be saved as SHOPIFY_ADMIN_TOKEN and survive a restart.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { config } from "./config.ts";
import { setInstalledToken } from "./shopify.ts";

const SHOP_DOMAIN = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;
const STATE_LIFETIME_MS = 10 * 60 * 1000;

/** Nonces handed out by /auth/install, each good for one callback within ten minutes. */
const pending = new Map<string, number>();

export class InstallError extends Error {}

function credentials(): { clientId: string; clientSecret: string } {
  const auth = config.shopify.auth;
  if ("clientId" in auth) return auth;

  throw new InstallError("Set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET before installing the app.");
}

export function callbackUrl(): string {
  if (!config.publicUrl) throw new InstallError("Set PUBLIC_URL so Shopify knows where to send the store back.");

  return `${config.publicUrl}/auth/callback`;
}

/** @returns The Shopify page where the store owner approves the app. */
export function authorizeUrl(): string {
  const { clientId } = credentials();
  const state = randomBytes(16).toString("hex");

  for (const [key, expires] of pending) if (expires < Date.now()) pending.delete(key);
  pending.set(state, Date.now() + STATE_LIFETIME_MS);

  const params = new URLSearchParams({
    client_id: clientId,
    scope: config.shopify.scopes,
    redirect_uri: callbackUrl(),
    state,
  });

  return `https://${config.shopify.shop}/admin/oauth/authorize?${params}`;
}

/** Shopify signs the callback with the client secret; anything unsigned is not from Shopify. */
function verifySignature(query: URLSearchParams, secret: string): boolean {
  const hmac = query.get("hmac") || "";
  const message = [...query.entries()]
    .filter(([key]) => key !== "hmac")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const digest = createHmac("sha256", secret).update(message).digest("hex");

  return hmac.length === digest.length && timingSafeEqual(Buffer.from(hmac), Buffer.from(digest));
}

/**
 * Turns the callback Shopify sent into a permanent token for the store.
 *
 * @returns The token and the scopes the store granted.
 */
export async function completeInstall(query: URLSearchParams): Promise<{ token: string; scope: string }> {
  const { clientId, clientSecret } = credentials();
  const shop = query.get("shop") || "";
  const state = query.get("state") || "";
  const code = query.get("code") || "";

  if (!SHOP_DOMAIN.test(shop) || shop !== config.shopify.shop) throw new InstallError(`This service serves ${config.shopify.shop}, not ${shop || "an unnamed shop"}.`);
  if (!verifySignature(query, clientSecret)) throw new InstallError("The callback is not signed by Shopify.");

  const expires = pending.get(state);
  pending.delete(state);
  if (!expires || expires < Date.now()) throw new InstallError("This install link has expired. Start again from /auth/install.");
  if (!code) throw new InstallError("Shopify sent no authorization code.");

  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code }),
    signal: AbortSignal.timeout(15000),
  });
  const body = (await response.json().catch(() => null)) as { access_token?: string; scope?: string } | null;

  if (!response.ok || !body?.access_token) throw new InstallError(`Shopify refused the authorization code (${response.status}).`);

  setInstalledToken(body.access_token);

  return { token: body.access_token, scope: body.scope || "" };
}
