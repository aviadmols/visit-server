/**
 * The quote email.
 *
 * Typography does the work: one family, a light line against a black one, hairline rules and
 * a single square button that opens the draft order's checkout. Styles are inline because
 * email clients cannot be trusted with a stylesheet.
 */

import { createTransport, type Transporter } from "nodemailer";

import { config } from "./config.ts";

export type Money = { amount: string; currencyCode: string };

export type QuoteEmail = {
  to: string;
  firstName: string;
  quoteName: string;
  kitTitle: string;
  /** The kit's picture, left out of the email when the product has none. */
  kitImageUrl: string;
  participants: number;
  unitPrice: Money | null;
  total: Money;
  eventDate: string | null;
  dateFlexible: boolean;
  causes: string[];
  invoiceUrl: string;
};

const CAUSE_LABELS: Record<string, string> = {
  children_families: "Support children and families",
  hunger: "Fight hunger and food insecurity",
  health_dignity: "Promote health, hygiene and dignity",
  learning: "Inspire learning and future skills",
  crisis: "Respond to crisis and urgent needs",
};

const FONT = "'Heebo',Helvetica,Arial,sans-serif";
const INK = "#000000";
const RULE = "#BCBCBC";
const MUTED = "#767676";

let transporter: Transporter | null = null;

function transport(): Transporter {
  transporter ??= createTransport({
    host: config.mail.host,
    port: config.mail.port,
    secure: config.mail.secure,
    auth: config.mail.user ? { user: config.mail.user, pass: config.mail.password } : undefined,
  });

  return transporter;
}

function money(value: Money | null): string {
  if (!value) return "";

  const amount = Number(value.amount);
  if (!Number.isFinite(amount)) return `${value.amount} ${value.currencyCode}`;

  return new Intl.NumberFormat("en-US", { style: "currency", currency: value.currencyCode }).format(amount);
}

function humanDate(value: string | null, flexible: boolean): string {
  if (flexible || !value) return "Flexible";

  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat("en-US", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(date);
}

function causeNames(values: string[]): string {
  return values.map((value) => CAUSE_LABELS[value] || value.replace(/_/g, " ")).join(", ");
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (character) => ESCAPES[character] ?? character);
}

/** One label and value of the quote, under a hairline rule. Empty values are left out. */
function row(label: string, value: string): string {
  if (!value) return "";

  return `
              <tr>
                <td style="padding:18px 0 0;border-top:1px solid ${RULE};font:500 11px/1.4 ${FONT};letter-spacing:3px;text-transform:uppercase;color:${MUTED};">${escapeHtml(label)}</td>
              </tr>
              <tr>
                <td style="padding:4px 0 18px;font:400 17px/1.5 ${FONT};color:${INK};">${escapeHtml(value)}</td>
              </tr>`;
}

function footerLinks(): string {
  const parts: string[] = [escapeHtml(config.brand.name)];

  if (config.brand.supportEmail) {
    const address = escapeHtml(config.brand.supportEmail);
    parts.push(`<a href="mailto:${address}" style="color:${MUTED};">${address}</a>`);
  }
  if (config.brand.url) {
    const url = escapeHtml(config.brand.url);
    parts.push(`<a href="${url}" style="color:${MUTED};">${escapeHtml(config.brand.url.replace(/^https?:\/\//, ""))}</a>`);
  }

  return parts.join(" &middot; ");
}

/** The kit's picture at the width of the email, above the numbers it explains. */
function kitImage(quote: QuoteEmail): string {
  if (!quote.kitImageUrl) return "";

  return `
            <tr>
              <td style="padding-bottom:40px;">
                <img src="${escapeHtml(quote.kitImageUrl)}" alt="${escapeHtml(quote.kitTitle)}" width="600" style="display:block;width:100%;max-width:600px;height:auto;border:0;border-radius:7px;">
              </td>
            </tr>`;
}

export function renderQuoteEmail(quote: QuoteEmail): string {
  const greeting = quote.firstName ? `Hi ${escapeHtml(quote.firstName)},` : "Hi,";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${escapeHtml(config.mail.subject)}</title>
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Heebo:wght@300;400;500;900&display=swap">
  </head>
  <body style="margin:0;padding:0;background:#FFFFFF;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(quote.kitTitle)} for ${quote.participants} people, priced and ready to order.</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FFFFFF;">
      <tr>
        <td align="center" style="padding:48px 24px;">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;">
            <tr>
              <td style="padding-bottom:56px;font:900 13px/1 ${FONT};letter-spacing:4px;text-transform:uppercase;color:${INK};">${escapeHtml(config.brand.name)}</td>
            </tr>
            <tr>
              <td style="padding-bottom:12px;font:500 11px/1 ${FONT};letter-spacing:4px;text-transform:uppercase;color:${MUTED};">Quote ${escapeHtml(quote.quoteName)}</td>
            </tr>
            <tr>
              <td style="padding-bottom:28px;font:300 40px/0.95 ${FONT};color:${INK};">
                Your quote is<br><span style="font-weight:900;">ready to order.</span>
              </td>
            </tr>
            <tr>
              <td style="padding-bottom:40px;font:300 18px/1.6 ${FONT};color:${INK};">
                ${greeting} here is what your team asked for, priced and held in one order. The button below opens a checkout with the kit already in it.
              </td>
            </tr>${kitImage(quote)}
            <tr>
              <td>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${row("Impact kit", quote.kitTitle)}${row("Participants", String(quote.participants))}${row("Per participant", money(quote.unitPrice))}${row("Total", money(quote.total))}${row("Event date", humanDate(quote.eventDate, quote.dateFlexible))}${row("Causes", causeNames(quote.causes))}
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:6px 0 0;border-top:1px solid ${INK};"></td>
            </tr>
            <tr>
              <td style="padding:32px 0 16px;">
                <a href="${escapeHtml(quote.invoiceUrl)}" style="display:inline-block;padding:20px 44px;background:${INK};border:1px solid ${INK};border-radius:0;font:500 13px/1 ${FONT};letter-spacing:3px;text-transform:uppercase;color:#FFFFFF;text-decoration:none;">Complete the order</a>
              </td>
            </tr>
            <tr>
              <td style="padding-bottom:56px;font:400 14px/1.6 ${FONT};color:${MUTED};">
                This price is held for this order. Reply to this email if anything should change.
              </td>
            </tr>
            <tr>
              <td style="padding-top:24px;border-top:1px solid ${RULE};font:400 12px/1.8 ${FONT};color:${MUTED};">${footerLinks()}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function renderQuoteText(quote: QuoteEmail): string {
  return [
    quote.firstName ? `Hi ${quote.firstName},` : "Hi,",
    "",
    `Your quote ${quote.quoteName} is ready to order.`,
    "",
    `Impact kit: ${quote.kitTitle}`,
    `Participants: ${quote.participants}`,
    quote.unitPrice ? `Per participant: ${money(quote.unitPrice)}` : "",
    `Total: ${money(quote.total)}`,
    `Event date: ${humanDate(quote.eventDate, quote.dateFlexible)}`,
    quote.causes.length > 0 ? `Causes: ${causeNames(quote.causes)}` : "",
    "",
    `Complete the order: ${quote.invoiceUrl}`,
    "",
    config.brand.name,
  ]
    .filter((line, index, lines) => line !== "" || lines[index - 1] !== "")
    .join("\n");
}

/** @returns What the relay answered, for the log: delivery beyond the relay is its business. */
export async function sendQuoteEmail(quote: QuoteEmail): Promise<{ response: string; messageId: string; rejected: string[] }> {
  const info = await transport().sendMail({
    from: config.mail.from,
    to: quote.to,
    replyTo: config.mail.replyTo || undefined,
    subject: `${config.mail.subject} ${quote.quoteName}`.trim(),
    text: renderQuoteText(quote),
    html: renderQuoteEmail(quote),
  });

  return { response: info.response, messageId: info.messageId, rejected: info.rejected.map(String) };
}
