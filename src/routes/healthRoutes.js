import { Router } from 'express';

const router = Router();

router.get('/', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

router.get('/email', (req, res) => {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_FROM } = process.env;
  const configured = Boolean(SMTP_HOST && SMTP_PORT);
  res.json({
    ok: true,
    smtpConfigured: configured,
    smtpHostSet: Boolean(SMTP_HOST),
    smtpPortSet: Boolean(SMTP_PORT),
    smtpUserSet: Boolean(SMTP_USER),
    smtpFromSet: Boolean(SMTP_FROM),
  });
});

export default router;
