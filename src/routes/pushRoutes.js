import express from 'express';
import { requireAuth } from '../middlewares/auth.js';
import { supabase } from '../config/supabase.js';
import { getVapidPublicKey } from '../utils/push.js';

const router = express.Router();

// Return VAPID public key for the client to subscribe
router.get('/vapidPublicKey', (req, res) => {
  return res.json({ publicKey: getVapidPublicKey() });
});

// Subscribe: save subscription JSON for the authenticated user
router.post('/subscribe', requireAuth, async (req, res, next) => {
  try {
    const { subscription } = req.body;
    if (!subscription) return res.status(400).json({ error: 'Missing subscription object' });
    const endpoint = subscription?.endpoint;
    if (!endpoint) return res.status(400).json({ error: 'Missing subscription.endpoint' });

    // Evitar usar ON CONFLICT: comprobamos si ya existe la misma suscripción (por endpoint)
    const { data: exists, error: existsErr } = await supabase
      .from('push_subscriptions')
      .select('id')
      .eq('user_id', req.user.id)
      .eq('subscription->>endpoint', endpoint)
      .maybeSingle();

    if (existsErr) return next(existsErr);
    if (exists) return res.json({ ok: true, existing: true });

    const { data, error } = await supabase.from('push_subscriptions').insert([{ user_id: req.user.id, subscription }]).select();
    if (error) return next(error);
    return res.json({ ok: true, data });
  } catch (e) {
    return next(e);
  }
});

// Unsubscribe: remove the subscription for the user
router.post('/unsubscribe', requireAuth, async (req, res, next) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });

    const { error } = await supabase.from('push_subscriptions').delete().eq('user_id', req.user.id).eq('subscription->>endpoint', endpoint);
    if (error) return next(error);
    return res.json({ ok: true });
  } catch (e) {
    return next(e);
  }
});

export default router;
