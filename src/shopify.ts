/**
 * The three Admin API calls this service makes.
 *
 * A quote becomes a draft order: it holds the kit, the quantity and the answers, and its
 * invoice URL is a checkout the customer can pay, which is what the email links to.
 */

import { config } from "./config.ts";

const endpoint = `https://${config.shopify.shop}/admin/api/${config.shopify.apiVersion}/graphql.json`;

export class ShopifyError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ShopifyError";
    this.code = code;
  }
}

type UserError = { field?: string[] | null; message: string };

/** The day-long token of a Dev Dashboard app, renewed a few minutes before Shopify expires it. */
let issued: { token: Promise<string>; renewAt: number } | null = null;
const RENEW_EARLY_MS = 5 * 60 * 1000;

/** The permanent token an install handshake produced. Lives until the process restarts. */
let installed: string | null = null;

export function setInstalledToken(token: string): void {
  installed = token;
  issued = null;
}

export function hasInstalledToken(): boolean {
  return installed !== null;
}

async function requestToken(clientId: string, clientSecret: string): Promise<{ token: string; lifetimeMs: number }> {
  let response: Response;
  try {
    response = await fetch(`https://${config.shopify.shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new ShopifyError("shopify_unreachable", "Shopify did not answer the token request in time.");
  }

  const body = (await response.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null;
  if (!response.ok || !body?.access_token) {
    // Shopify answers 400 when the app and the store are not in one organization; the install handshake covers that case.
    throw new ShopifyError("shopify_auth_failed", `Shopify refused the client credentials (${response.status}). If the app is not in the store's own organization, install it at ${config.publicUrl}/auth/install.`);
  }

  return { token: body.access_token, lifetimeMs: (body.expires_in ?? 86399) * 1000 };
}

async function accessToken(): Promise<string> {
  const auth = config.shopify.auth;
  // An install that just happened is the newer credential, and the page that ran it promised
  // quotes would work; a token left in the environment may well be the revoked one.
  if (installed) return installed;
  if ("token" in auth) return auth.token;

  if (!issued || Date.now() >= issued.renewAt) {
    // Requests that arrive together share one token request instead of each asking for their own.
    const pending = requestToken(auth.clientId, auth.clientSecret);
    const current = { token: pending.then((result) => result.token), renewAt: Infinity };
    issued = current;

    pending.then(
      (result) => { current.renewAt = Date.now() + result.lifetimeMs - RENEW_EARLY_MS; },
      () => { if (issued === current) issued = null; }
    );

    return current.token;
  }

  return issued.token;
}

async function graphql<T>(query: string, variables: Record<string, unknown>, retried = false): Promise<T> {
  const token = await accessToken();

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new ShopifyError("shopify_unreachable", "Shopify did not answer in time.");
  }

  // A token revoked early (the app reinstalled, the secret rotated) is replaced once.
  if (response.status === 401 && !retried && !("token" in config.shopify.auth) && !installed) {
    issued = null;
    return graphql<T>(query, variables, true);
  }

  const body = (await response.json().catch(() => null)) as { data?: T; errors?: { message: string }[] } | null;

  if (!response.ok || !body) {
    throw new ShopifyError(`shopify_http_${response.status}`, `Shopify replied ${response.status}.`);
  }
  if (body.errors?.length) {
    throw new ShopifyError("shopify_query_failed", body.errors.map((error) => error.message).join("; "));
  }
  if (!body.data) {
    throw new ShopifyError("shopify_empty_response", "Shopify returned no data.");
  }

  return body.data;
}

function firstUserError(errors: UserError[] | undefined): string {
  const error = errors?.[0];
  if (!error) return "";

  return [error.field?.join("."), error.message].filter(Boolean).join(": ");
}

export type Money = { amount: string; currencyCode: string };

export type DraftOrder = {
  id: string;
  name: string;
  invoiceUrl: string;
  total: Money;
  line: { title: string; quantity: number; unitPrice: Money } | null;
};

const DRAFT_ORDER_CREATE = `
  mutation CreateQuote($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder {
        id
        name
        invoiceUrl
        totalPriceSet { shopMoney { amount currencyCode } }
        lineItems(first: 1) {
          nodes {
            title
            quantity
            originalUnitPriceSet { shopMoney { amount currencyCode } }
          }
        }
      }
      userErrors { field message }
    }
  }
`;

type DraftOrderCreateData = {
  draftOrderCreate: {
    draftOrder: {
      id: string;
      name: string;
      invoiceUrl: string | null;
      totalPriceSet: { shopMoney: Money };
      lineItems: { nodes: { title: string; quantity: number; originalUnitPriceSet: { shopMoney: Money } }[] };
    } | null;
    userErrors: UserError[];
  };
};

export type DraftOrderRequest = {
  email: string;
  variantId: string;
  quantity: number;
  note: string;
  /** Tags Shopify can be searched by, on top of the ones in the configuration. */
  extraTags?: string[];
  /** Shown in admin under the order's additional details. */
  attributes: { key: string; value: string }[];
  /** Line item properties; a key that starts with _ stays hidden from the customer. */
  properties: { key: string; value: string }[];
};

export async function createDraftOrder(request: DraftOrderRequest): Promise<DraftOrder> {
  const data = await graphql<DraftOrderCreateData>(DRAFT_ORDER_CREATE, {
    input: {
      email: request.email,
      lineItems: [{ variantId: request.variantId, quantity: request.quantity, customAttributes: request.properties }],
      customAttributes: request.attributes,
      note: request.note,
      tags: [...config.shopify.draftOrderTags, ...(request.extraTags ?? [])],
    },
  });

  const result = data.draftOrderCreate;
  const draft = result.draftOrder;
  if (!draft) {
    throw new ShopifyError("draft_order_rejected", firstUserError(result.userErrors) || "Shopify refused the draft order.");
  }
  if (!draft.invoiceUrl) {
    throw new ShopifyError("draft_order_without_invoice", "The draft order has no invoice URL to pay.");
  }

  const line = draft.lineItems.nodes[0];

  return {
    id: draft.id,
    name: draft.name,
    invoiceUrl: draft.invoiceUrl,
    total: draft.totalPriceSet.shopMoney,
    line: line ? { title: line.title, quantity: line.quantity, unitPrice: line.originalUnitPriceSet.shopMoney } : null,
  };
}

const DRAFT_ORDER_BY_TAG = `
  query QuoteByTag($query: String!) {
    draftOrders(first: 1, query: $query) {
      nodes {
        id
        name
        invoiceUrl
        totalPriceSet { shopMoney { amount currencyCode } }
        lineItems(first: 1) {
          nodes {
            title
            quantity
            originalUnitPriceSet { shopMoney { amount currencyCode } }
          }
        }
      }
    }
  }
`;

/**
 * Finds a draft order this service already created, by the tag it stamps on each attempt.
 *
 * Shopify can accept a draft order and still leave the answer unread, and the storefront
 * retries with the same key. Without this lookup that retry would create a second quote.
 *
 * @returns The draft order, or null when this attempt never reached Shopify.
 */
export async function findDraftOrderByTag(tag: string): Promise<DraftOrder | null> {
  const data = await graphql<{
    draftOrders: {
      nodes: {
        id: string;
        name: string;
        invoiceUrl: string | null;
        totalPriceSet: { shopMoney: Money };
        lineItems: { nodes: { title: string; quantity: number; originalUnitPriceSet: { shopMoney: Money } }[] };
      }[];
    };
  }>(DRAFT_ORDER_BY_TAG, { query: `tag:'${tag.replace(/['\\]/g, "")}'` });

  const draft = data.draftOrders.nodes[0];
  if (!draft?.invoiceUrl) return null;

  const line = draft.lineItems.nodes[0];

  return {
    id: draft.id,
    name: draft.name,
    invoiceUrl: draft.invoiceUrl,
    total: draft.totalPriceSet.shopMoney,
    line: line ? { title: line.title, quantity: line.quantity, unitPrice: line.originalUnitPriceSet.shopMoney } : null,
  };
}

const LINE_IMAGE = `
  query QuoteLineImage($id: ID!) {
    draftOrder(id: $id) {
      lineItems(first: 1) {
        nodes { image { url(transform: { maxWidth: 1200 }) } }
      }
    }
  }
`;

/**
 * The picture of the kit on the draft order, asked for separately so that a scope the app
 * lacks can cost the email its picture but never the quote its draft order.
 *
 * @returns The image URL, or an empty string when the line has none.
 */
export async function lineImageUrl(draftOrderId: string): Promise<string> {
  const data = await graphql<{ draftOrder: { lineItems: { nodes: { image: { url: string } | null }[] } } | null }>(LINE_IMAGE, { id: draftOrderId });

  return data.draftOrder?.lineItems.nodes[0]?.image?.url ?? "";
}

const CUSTOMER_BY_EMAIL = `
  query CustomerByEmail($query: String!) {
    customers(first: 1, query: $query) {
      nodes { id }
    }
  }
`;

/** @returns The customer's id, or null when this email has never bought or signed up. */
export async function findCustomerId(email: string): Promise<string | null> {
  const data = await graphql<{ customers: { nodes: { id: string }[] } }>(CUSTOMER_BY_EMAIL, {
    // A quote and a backslash both end the quoted term early, so neither reaches the query.
    query: `email:"${email.replace(/["\\]/g, "")}"`,
  });

  return data.customers.nodes[0]?.id ?? null;
}

const METAFIELDS_SET = `
  mutation SetQuoteLink($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors { field message }
    }
  }
`;

/** Points the customer's metafield at their newest quote. */
export async function setCustomerQuoteLink(customerId: string, invoiceUrl: string): Promise<void> {
  const data = await graphql<{ metafieldsSet: { userErrors: UserError[] } }>(METAFIELDS_SET, {
    metafields: [
      {
        ownerId: customerId,
        namespace: config.shopify.metafield.namespace,
        key: config.shopify.metafield.key,
        type: config.shopify.metafield.type,
        value: invoiceUrl,
      },
    ],
  });

  const message = firstUserError(data.metafieldsSet.userErrors);
  if (message) throw new ShopifyError("metafield_rejected", message);
}

/** @returns The shop's name, which proves the credentials and the shop domain belong together. */
export async function shopName(): Promise<string> {
  const data = await graphql<{ shop: { name: string } }>(`query { shop { name } }`, {});
  return data.shop.name;
}
