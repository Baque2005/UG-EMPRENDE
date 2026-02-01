import nodemailer from 'nodemailer';

const {
  EMAIL_PROVIDER,
  RESEND_API_KEY,
  RESEND_FROM,
  BREVO_API_KEY,
  BREVO_FROM_EMAIL,
  BREVO_FROM_NAME,
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

async function sendViaResend({ to, subject, text, html }) {
  if (!RESEND_API_KEY) return { ok: false, error: 'RESEND_API_KEY not configured' };

  const from = RESEND_FROM || SMTP_FROM || SMTP_USER;
  if (!from) return { ok: false, error: 'Missing from (RESEND_FROM/SMTP_FROM/SMTP_USER)' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        text,
        html,
      }),
      signal: controller.signal,
    });

    const data = await res.json().catch(() => null);

    if (!res.ok) {
      const msg = data?.message || data?.error || `HTTP ${res.status}`;
      return { ok: false, error: msg, provider: 'resend', status: res.status, data };
    }

    return { ok: true, info: data, provider: 'resend' };
  } catch (err) {
    return { ok: false, error: err?.name === 'AbortError' ? 'Resend request timeout' : (err?.message || String(err)), provider: 'resend' };
  } finally {
    clearTimeout(timeout);
  }
}

async function sendViaBrevo({ to, subject, text, html }) {
  if (!BREVO_API_KEY) return { ok: false, error: 'BREVO_API_KEY not configured' };

  const fromEmail = BREVO_FROM_EMAIL || SMTP_USER;
  const fromName = BREVO_FROM_NAME || 'UG Emprende';
  if (!fromEmail) return { ok: false, error: 'Missing from email (BREVO_FROM_EMAIL/SMTP_USER)' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': BREVO_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { email: fromEmail, name: fromName },
        to: [{ email: to }],
        subject,
        textContent: text,
        htmlContent: html,
      }),
      signal: controller.signal,
    });

    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = data?.message || data?.error || `HTTP ${res.status}`;
      return { ok: false, error: msg, provider: 'brevo', status: res.status, data };
    }

    return { ok: true, info: data, provider: 'brevo' };
  } catch (err) {
    return {
      ok: false,
      error: err?.name === 'AbortError' ? 'Brevo request timeout' : (err?.message || String(err)),
      provider: 'brevo',
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function sendEmail({ to, subject, text, html }) {
  const provider = String(EMAIL_PROVIDER || '').toLowerCase().trim();

  // Prefer Brevo (HTTPS) when configured; avoids SMTP egress blocks.
  if (provider === 'brevo' || (BREVO_API_KEY && provider !== 'smtp' && provider !== 'resend')) {
    const b = await sendViaBrevo({ to, subject, text, html });
    if (b.ok) return b;
    if (provider === 'brevo') return b;
  }

  // Prefer Resend (HTTPS) when configured; SMTP from Render is commonly blocked/timeouts.
  if (provider === 'resend' || (RESEND_API_KEY && provider !== 'smtp')) {
    const r = await sendViaResend({ to, subject, text, html });
    if (r.ok) return r;

    // If user explicitly requested resend, don't silently fall back to SMTP.
    if (provider === 'resend') return r;
  }

  const t = getTransporter();
  if (!t) {
    // Best-effort: if no SMTP, skip but return ok=false
    return { ok: false, error: 'SMTP not configured' };
  }

  const from = SMTP_FROM || SMTP_USER || `no-reply@localhost`;

  try {
    const info = await t.sendMail({ from, to, subject, text, html });
    return { ok: true, info, provider: 'smtp' };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), provider: 'smtp' };
  }
}

export default sendEmail;
// Nota: export default y export named `sendEmail` están disponibles arriba.
