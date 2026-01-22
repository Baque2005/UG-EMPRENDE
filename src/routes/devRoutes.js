import { Router } from 'express';
import sendEmail from '../utils/sendEmail.js';

const router = Router();

// Ruta de prueba para enviar un email. Solo disponible en desarrollo.
router.post('/send-test-email', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }

  const to = req.body.to || req.query.to || process.env.SMTP_USER;
  const subject = req.body.subject || 'Prueba de correo — UG Emprende';
  const text = req.body.text || 'Este es un correo de prueba enviado desde el backend.';
  const html = req.body.html || `<p>${text.replace(/\n/g, '<br/>')}</p>`;

  if (!to) return res.status(400).json({ error: 'Missing recipient (to)' });

  try {
    const result = await sendEmail({ to, subject, text, html });
    if (!result.ok) return res.status(500).json({ ok: false, error: result.error || 'send failed', result });
    return res.json({ ok: true, info: result.info });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

export default router;
