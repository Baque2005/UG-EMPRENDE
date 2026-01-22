import nodemailer from 'nodemailer';

const {
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  SMTP_FROM,
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
    secure: Number(SMTP_PORT) === 465, // true for 465, false for others
    auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
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
