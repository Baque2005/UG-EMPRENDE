import { Router } from 'express';

const router = Router();

router.get('/', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

router.get('/email', (req, res) => {
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
    SMTP_FROM,
  } = process.env;
  const configured = Boolean(SMTP_HOST && SMTP_PORT);
  res.json({
    ok: true,
    emailProvider: String(EMAIL_PROVIDER || '').toLowerCase() || (BREVO_API_KEY ? 'brevo' : (RESEND_API_KEY ? 'resend' : 'smtp')),
    resendKeySet: Boolean(RESEND_API_KEY),
    resendFromSet: Boolean(RESEND_FROM),
    brevoKeySet: Boolean(BREVO_API_KEY),
    brevoFromEmailSet: Boolean(BREVO_FROM_EMAIL),
    brevoFromNameSet: Boolean(BREVO_FROM_NAME),
    smtpConfigured: configured,
    smtpHostSet: Boolean(SMTP_HOST),
    smtpPortSet: Boolean(SMTP_PORT),
    smtpUserSet: Boolean(SMTP_USER),
    smtpFromSet: Boolean(SMTP_FROM),
  });
});

export default router;
