import nodemailer from 'nodemailer';

const {
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  SMTP_FROM,
  SMTP_SECURE,
  SMTP_REQUIRE_TLS,
  SMTP_CONNECTION_TIMEOUT_MS,
  SMTP_SOCKET_TIMEOUT_MS,
  SMTP_GREETING_TIMEOUT_MS,
} = process.env;

let transporter;
function getTransporter() {
  if (transporter) return transporter;
  if (!SMTP_HOST || !SMTP_PORT) {
    // No SMTP configured
    return null;
  }

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    // Default: 465 => implicit TLS, others => STARTTLS
    secure: typeof SMTP_SECURE === 'string'
      ? String(SMTP_SECURE).toLowerCase() === 'true'
      : Number(SMTP_PORT) === 465,
    auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
    requireTLS: typeof SMTP_REQUIRE_TLS === 'string' ? String(SMTP_REQUIRE_TLS).toLowerCase() === 'true' : undefined,
    connectionTimeout: Number(SMTP_CONNECTION_TIMEOUT_MS) || 15_000,
    socketTimeout: Number(SMTP_SOCKET_TIMEOUT_MS) || 20_000,
    greetingTimeout: Number(SMTP_GREETING_TIMEOUT_MS) || 15_000,
    tls: {
      // Helps with some providers/certs; safe default.
      servername: SMTP_HOST,
    },
  });

  return transporter;
}

export async function sendEmail({ to, subject, text, html }) {
  const t = getTransporter();
  if (!t) {
    // Best-effort: if no SMTP, skip but return ok=false
    return { ok: false, error: 'SMTP not configured' };
  }

  const from = SMTP_FROM || SMTP_USER || `no-reply@localhost`;

  try {
    const info = await t.sendMail({ from, to, subject, text, html });
    return { ok: true, info };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export default sendEmail;
// Nota: export default y export named `sendEmail` están disponibles arriba.
