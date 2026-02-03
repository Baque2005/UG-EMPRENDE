import { Router } from 'express';
import { supabase } from '../config/supabase.js';

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

router.get('/supabase', async (req, res) => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const timeoutMs = Number(process.env.HEALTHCHECK_TIMEOUT_MS || 8000);

  const makeTimeout = () => {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    return { controller, id };
  };

  // 1) Auth: golpea el endpoint de settings (prueba conectividad + DNS + TLS)
  let authOk = false;
  let authStatus = null;
  let authError = null;
  if (supabaseUrl) {
    const { controller, id } = makeTimeout();
    try {
      const resp = await fetch(`${String(supabaseUrl).replace(/\/+$/u, '')}/auth/v1/settings`, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          apikey: String(anonKey || serviceRoleKey || ''),
        },
      });
      authStatus = resp.status;
      authOk = resp.ok;
    } catch (e) {
      authError = e?.name === 'AbortError' ? 'timeout' : String(e?.message || e);
    } finally {
      clearTimeout(id);
    }
  }

  // 2) DB: query mínima (depende de conexión a PostgREST)
  let dbOk = false;
  let dbError = null;
  try {
    const { error } = await supabase.from('profiles').select('id').limit(1);
    if (error) dbError = error.message || String(error);
    dbOk = !error;
  } catch (e) {
    dbError = String(e?.message || e);
  }

  const ok = Boolean(authOk && dbOk);
  const status = ok ? 200 : 503;

  return res.status(status).json({
    ok,
    timestamp: new Date().toISOString(),
    configured: {
      supabaseUrlSet: Boolean(supabaseUrl),
      supabaseAnonKeySet: Boolean(anonKey),
      supabaseServiceRoleKeySet: Boolean(serviceRoleKey),
    },
    auth: { ok: authOk, status: authStatus, error: authError },
    db: { ok: dbOk, error: dbError },
  });
});

export default router;
