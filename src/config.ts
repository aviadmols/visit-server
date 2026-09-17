/**
 * Every setting the service needs, read once at boot.
 *
 * A missing credential fails here rather than on the first quote, so a bad deploy is
 * obvious immediately instead of losing a request.
 */

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);

  return value;
}

function optional(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function number(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function list(name: string): string[] {
  return optional(name)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export const config = {
  port: number("PORT", 3000),

  /** Storefront origins allowed to post a quote. Empty means any origin. */
  allowedOrigins: list("ALLOWED_ORIGINS"),

  /** When set, a request must carry it as x-quote-token. */
  apiToken: optional("QUOTE_API_TOKEN"),

  shopify: {
    /** my-shop.myshopify.com, without the scheme. */
    shop: required("SHOPIFY_SHOP").replace(/^https?:\/\//, "").replace(/\/+$/, ""),
    /** Admin API access token of the custom app (shpat_...). */
    token: required("SHOPIFY_ADMIN_TOKEN"),
    apiVersion: optional("SHOPIFY_API_VERSION", "2026-07"),
    /** Where the link to the customer's latest quote is stored. */
    metafield: {
      namespace: optional("SHOPIFY_METAFIELD_NAMESPACE", "visit"),
      key: optional("SHOPIFY_METAFIELD_KEY", "last_quote_url"),
      type: optional("SHOPIFY_METAFIELD_TYPE", "url"),
    },
    draftOrderTags: list("SHOPIFY_DRAFT_ORDER_TAGS"),
  },

  mail: {
    host: required("SMTP_HOST"),
    port: number("SMTP_PORT", 587),
    /** True for port 465, false for the STARTTLS ports. */
    secure: optional("SMTP_SECURE", "false") === "true",
    user: optional("SMTP_USER"),
    password: optional("SMTP_PASSWORD"),
    from: required("MAIL_FROM"),
    replyTo: optional("MAIL_REPLY_TO"),
    subject: optional("MAIL_SUBJECT", "Your Impact Kit quote"),
  },

  brand: {
    name: optional("BRAND_NAME", "Visit.org"),
    url: optional("BRAND_URL", ""),
    supportEmail: optional("BRAND_SUPPORT_EMAIL", ""),
  },

  log: {
    file: optional("LOG_FILE", "logs/quotes.log"),
    /** The file is emptied once it holds this many records. */
    maxRecords: number("LOG_MAX_RECORDS", 100),
  },
} as const;

export type Config = typeof config;
