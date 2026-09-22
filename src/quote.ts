/**
 * What happens when the quiz asks for a quote.
 *
 * The kit and the answers become a draft order in the requester's name, the customer record
 * (when there is one) is pointed at it, and the email carries the numbers and the pay link.
 * Only the draft order is essential: a metafield or a mail server that refuses must not lose
 * a quote that Shopify already holds.
 */

import { log } from "./log.ts";
import { sendQuoteEmail } from "./email.ts";
import { createDraftOrder, findCustomerId, setCustomerQuoteLink, ShopifyError } from "./shopify.ts";

export class RequestError extends Error {
  code: string;
  status: number;
  fieldErrors: Record<string, string>;

  constructor(code: string, status: number, message: string, fieldErrors: Record<string, string> = {}) {
    super(message);
    this.name = "RequestError";
    this.code = code;
    this.status = status;
    this.fieldErrors = fieldErrors;
  }
}

/** The fields this service uses out of the quiz payload. The rest is carried, not read. */
type QuotePayload = {
  /** "checkout" when the customer is on their way to pay, so the email can be skipped. */
  action_type: "quote" | "checkout";
  work_email: string;
  first_name: string;
  last_name: string;
  company_name: string;
  phone: string;
  event_date: string | null;
  date_flexible: boolean;
  participant_count: number;
  budget_per_participant: string;
  impact_categories: string[];
  impact_category: string;
  selected_variant_id: string;
  delivery_model: string;
  city: string;
  country: string;
  source: string;
  page_url: string;
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function causes(body: Record<string, unknown>): string[] {
  const many = body.impact_categories;
  if (Array.isArray(many)) return many.map(text).filter(Boolean);

  const one = text(body.impact_category);
  return one ? [one] : [];
}

/**
 * Accepts the id in either shape the storefront may send it, since a quiz configured against
 * the Storefront API sends a global id and one built from Liquid sends the bare number.
 */
function variantGid(value: string): string {
  if (value.startsWith("gid://shopify/ProductVariant/")) return value;
  if (/^\d+$/.test(value)) return `gid://shopify/ProductVariant/${value}`;

  return "";
}

function read(body: unknown): QuotePayload {
  if (!body || typeof body !== "object") {
    throw new RequestError("invalid_payload", 400, "The request body is not an object.");
  }

  const source = body as Record<string, unknown>;
  const fieldErrors: Record<string, string> = {};

  const email = text(source.work_email).toLowerCase();
  if (!EMAIL.test(email)) fieldErrors.work_email = "Enter a valid work email address.";

  const participants = Number(source.participant_count);
  if (!Number.isInteger(participants) || participants < 1) {
    fieldErrors.participant_count = "Enter how many people will take part.";
  }

  const variant = variantGid(text(source.selected_variant_id));
  if (!variant) fieldErrors.selected_variant_id = "Choose a kit before asking for a quote.";

  if (Object.keys(fieldErrors).length > 0) {
    throw new RequestError("invalid_payload", 422, "The quote request is incomplete.", fieldErrors);
  }

  return {
    action_type: text(source.action_type) === "checkout" ? "checkout" : "quote",
    work_email: email,
    first_name: text(source.first_name),
    last_name: text(source.last_name),
    company_name: text(source.company_name),
    phone: text(source.phone),
    event_date: text(source.event_date) || null,
    date_flexible: Boolean(source.date_flexible),
    participant_count: participants,
    budget_per_participant: text(source.budget_per_participant),
    impact_categories: causes(source),
    impact_category: text(source.impact_category),
    selected_variant_id: variant,
    delivery_model: text(source.delivery_model),
    city: text(source.city),
    country: text(source.country),
    source: text(source.source) || "storefront_quiz",
    page_url: text(source.page_url),
  };
}

/** The answers, written the way they should read on the order in admin. */
function attributes(quote: QuotePayload): { key: string; value: string }[] {
  const pairs: Record<string, string> = {
    Action: quote.action_type === "checkout" ? "Continued to checkout" : "Asked for a quote",
    Participants: String(quote.participant_count),
    Causes: quote.impact_categories.join(", "),
    "Budget per participant": quote.budget_per_participant,
    "Event date": quote.date_flexible ? "Flexible" : quote.event_date || "",
    Company: quote.company_name,
    Phone: quote.phone,
    Delivery: [quote.delivery_model, quote.city, quote.country].filter(Boolean).join(", "),
    Source: quote.source,
    "Quiz page": quote.page_url,
  };

  return Object.entries(pairs)
    .filter(([, value]) => value !== "")
    .map(([key, value]) => ({ key, value }));
}

export type QuoteResult = {
  submission_id: string;
  integration_status: string;
  /** The draft order's checkout, which opens with the customer's email already filled in. */
  invoice_url: string;
};

export async function handleQuote(body: unknown): Promise<QuoteResult> {
  const quote = read(body);
  const name = [quote.first_name, quote.last_name].filter(Boolean).join(" ");
  const who = `${name || quote.work_email}${quote.company_name ? ` (${quote.company_name})` : ""}`;
  const checkout = quote.action_type === "checkout";

  const draft = await createDraftOrder({
    email: quote.work_email,
    variantId: quote.selected_variant_id,
    quantity: quote.participant_count,
    note: checkout ? `Impact Kit quiz checkout for ${who}.` : `Impact Kit quiz quote for ${who}.`,
    attributes: attributes(quote),
  });

  log("draft_order_created", { draft: draft.name, email: quote.work_email, participants: quote.participant_count, action: quote.action_type });

  const linked = await linkCustomer(quote.work_email, draft.invoiceUrl);

  // On the way to pay, the invoice is the answer; an email as well would only interrupt.
  if (checkout) {
    return { submission_id: draft.name, integration_status: linked ? "checkout_ready" : "checkout_ready_customer_unlinked", invoice_url: draft.invoiceUrl };
  }

  const emailed = await deliverEmail(quote, draft.name, draft.invoiceUrl, draft.line, draft.total);

  return {
    submission_id: draft.name,
    integration_status: emailed ? (linked ? "quote_sent" : "quote_sent_customer_unlinked") : "quote_created_email_failed",
    invoice_url: draft.invoiceUrl,
  };
}

/** @returns Whether the customer record now points at this quote. */
async function linkCustomer(email: string, invoiceUrl: string): Promise<boolean> {
  try {
    const customerId = await findCustomerId(email);
    if (!customerId) {
      log("customer_not_found", { email });
      return false;
    }

    await setCustomerQuoteLink(customerId, invoiceUrl);
    log("customer_linked", { email, customer: customerId });
    return true;
  } catch (error) {
    log("customer_link_failed", { email, code: error instanceof ShopifyError ? error.code : "unknown", message: String(error) });
    return false;
  }
}

/** @returns Whether the quote email left the building. */
async function deliverEmail(
  quote: QuotePayload,
  quoteName: string,
  invoiceUrl: string,
  line: { title: string; quantity: number; unitPrice: { amount: string; currencyCode: string }; imageUrl: string } | null,
  total: { amount: string; currencyCode: string }
): Promise<boolean> {
  try {
    const relay = await sendQuoteEmail({
      to: quote.work_email,
      firstName: quote.first_name,
      quoteName,
      kitTitle: line?.title || "Impact Kit",
      kitImageUrl: line?.imageUrl || "",
      participants: quote.participant_count,
      unitPrice: line?.unitPrice ?? null,
      total,
      eventDate: quote.event_date,
      dateFlexible: quote.date_flexible,
      causes: quote.impact_categories,
      invoiceUrl,
    });

    log("quote_email_sent", { to: quote.work_email, draft: quoteName, ...relay });
    return true;
  } catch (error) {
    log("quote_email_failed", { to: quote.work_email, draft: quoteName, message: String(error) });
    return false;
  }
}
