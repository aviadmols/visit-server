// One-off check of the mail relay with the service's own settings: `railway run node smtp-check.mjs <to>`.
// Prints what the relay answers and never the credentials.
import { createTransport } from "nodemailer";

const to = process.argv[2];
if (!to) {
  console.error("usage: node smtp-check.mjs recipient@example.com");
  process.exit(1);
}

const transporter = createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === "true",
  auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
});

console.log("relay:", process.env.SMTP_HOST, "port", process.env.SMTP_PORT, "user", process.env.SMTP_USER, "from", process.env.MAIL_FROM);
console.log("verify:", await transporter.verify());

const info = await transporter.sendMail({
  from: process.env.MAIL_FROM,
  to,
  subject: `SMTP check ${new Date().toISOString()}`,
  text: "If you can read this, the relay delivers to this address.",
});
console.log("accepted:", info.accepted, "rejected:", info.rejected);
console.log("response:", info.response);
console.log("messageId:", info.messageId);
