# Visit quote service

Receives a quote request from the Impact Kit quiz on the storefront and does three things:

1. Creates a **draft order** in Shopify for the chosen kit, one unit per participant, under the
   requester's email, with every quiz answer attached as an order attribute.
2. Looks the email up in **Customers**. When it belongs to an existing customer, that customer's
   metafield is pointed at the quote, so the record shows where the latest offer lives.
3. Sends the requester a **quote email** with the numbers and one button that opens the draft
   order's checkout, so they can pay without going back through the quiz.

The draft order is the only step that must succeed. A metafield that is refused or a mail server
that is down is recorded and reported back, never a reason to lose a quote Shopify already holds.

## Requirements

- Node 22.9 or newer (Node runs the TypeScript directly in development; production runs the build).
- A Shopify app on the store with the scopes `write_draft_orders`, `read_customers`, `write_customers`
  (see [Giving the service access to the store](#giving-the-service-access-to-the-store)).
- An SMTP account for the outgoing email.

## Setup

```bash
npm install
cp .env.example .env     # fill in the Shopify and SMTP values
npm run build
npm start
```

For development, `npm run dev` restarts on every change and needs no build step.

Every setting lives in `.env` and is read once at boot; a missing credential stops the service
immediately rather than failing on the first quote. See `.env.example` for the full list.

### Giving the service access to the store

Since January 2026 Shopify no longer lets a store create a custom app with a fixed `shpat_`
token. The app is built in the Dev Dashboard instead, and the service signs in with the app's
client id and secret, trading them for a token that lasts 24 hours and renewing it on its own.
This only works when the app and the store belong to the same Shopify organization, so the app
is created from the store's own admin, by the owner or a staff member with the
*App development → Develop* permission:

1. In admin, **Settings → Apps → Develop apps → Build apps in Dev Dashboard**, then **Create app**.
2. In the new version, set the **App URL** to this service's public URL, turn off embedding in
   the admin, and under **Access** enter the scopes `write_draft_orders,read_customers,write_customers`.
3. **Release** the version, then open the app's **Installs** section and **Install app** on the store.
4. From the app's **Settings**, copy the **Client ID** and **Client secret** into
   `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET`.

A legacy custom app created in admin before January 2026 still works: leave the client values
empty and put its token in `SHOPIFY_ADMIN_TOKEN`.

#### An app from a Partner account

When the app is created in a Partner (or any other) organization, Shopify answers the client
credentials with `400`, and the store has to install the app instead:

1. In the app's version, add `https://<service>/auth/callback` under **Redirect URLs** and release it.
2. Choose **Custom distribution** for the store, then open `https://<service>/auth/install` and
   approve the app in the store's admin.
3. The page that follows shows the store's permanent token. Save it as `SHOPIFY_ADMIN_TOKEN`
   and deploy, or the service forgets it on the next restart.

`PUBLIC_URL` is the service's own address for that redirect; Railway sets it automatically.

At boot the service asks Shopify for the shop's name and logs `shopify_connected` or
`shopify_connection_failed`, so a wrong secret or a missing install shows in the deploy log.

### The customer metafield

`metafieldsSet` writes the value whether or not a definition exists, but Shopify only shows it on
the customer page once it is defined. In admin, go to **Settings → Custom data → Customers** and
add a definition with namespace `visit`, key `last_quote_url` and type **URL**. Change
`SHOPIFY_METAFIELD_*` in `.env` if you prefer different names.

## Connecting the storefront

In the theme editor, open the *Find your kit* page, select the **Impact kit: quiz story** section
and set:

- **Quiz service base URL** to this service's public URL, with no trailing slash.
- **Development mode** off, so submissions are sent instead of logged in the browser console.

Add the storefront origin to `ALLOWED_ORIGINS`, since the browser posts here cross-origin.

## Endpoints

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/health` | Liveness check. |
| `POST` | `/api/quiz/match` | Answers `{}` on purpose. The quiz keeps the ranking it worked out in the browser, and this route exists so that configuring a service URL does not break the kits screen. |
| `POST` | `/api/quiz/submissions` | The quote request. Returns `{ submission_id, integration_status, invoice_url }`. With `action_type: "checkout"` the draft order is created but no email is sent, and the quiz sends the customer to `invoice_url`, a checkout that already carries their email. |

`submission_id` is the draft order name, for example `#D42`. `integration_status` is one of
`quote_sent`, `quote_sent_customer_unlinked` (no customer record for that email, or the metafield
was refused), `quote_created_email_failed` (the draft order exists, the email did not go out), or
for a checkout `checkout_ready` / `checkout_ready_customer_unlinked`.

Errors answer with `{ error_code, message }` and, when a field is at fault, `field_errors`, which
is the shape the quiz already understands.

The quiz sends an `Idempotency-Key` header. A repeat of the same key returns the first answer
instead of creating a second draft order; a failed attempt releases its key so a retry can work.

### Required fields

The payload is the quiz submission. Three fields are load bearing:

- `work_email` — the requester, and the email address on the draft order.
- `participant_count` — the quantity on the line.
- `selected_variant_id` — the kit, as a global id (`gid://shopify/ProductVariant/123`) or a bare
  numeric id. A quote with no kit chosen is refused with `422`.

Everything else (causes, budget, event date, company, delivery, UTM values) is carried onto the
draft order as an attribute, so the order explains itself in admin.

## Checking the mail relay

`railway run node smtp-check.mjs you@example.com` sends one test message with the service's own
SMTP settings and prints the relay's answer. Every `quote_email_sent` record also carries that
answer (`response`, `messageId`), so a quote that was accepted by the relay but never arrived is
a question for the relay or the recipient's spam filter, not for the service.

## Logging

One JSON line per record, written to stdout and to `LOG_FILE`. The file is emptied as soon as it
holds `LOG_MAX_RECORDS` lines (100 by default), which keeps the log to "what happened just now"
without a rotation tool behind it. For anything longer lived, ship stdout to the host's own log.

## Layout

| File | Holds |
| --- | --- |
| `src/config.ts` | Every setting, read once at boot. |
| `src/server.ts` | The HTTP surface: routing, CORS, idempotency, error shapes. |
| `src/quote.ts` | The flow, and the validation of what the quiz sent. |
| `src/shopify.ts` | The three Admin API calls. |
| `src/email.ts` | The quote email, in markup and in plain text. |
| `src/log.ts` | The record log and its 100 line limit. |
