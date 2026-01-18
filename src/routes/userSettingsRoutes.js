import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase.js';
import { requireAuth } from '../middlewares/auth.js';

const router = Router();

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('user_settings')
      .select('*')
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (error) return res.status(400).json({ error: error.message });

    // Defaults si no existe fila aún
    const settings = data || {
      user_id: req.user.id,
      email_notifications: true,
      push_notifications: true,
      two_factor_enabled: false,
    };

    return res.json({ settings });
  } catch (err) {
    return next(err);
  }
});

const updateSchema = z
  .object({
    emailNotifications: z.boolean().optional(),
    pushNotifications: z.boolean().optional(),
    twoFactorEnabled: z.boolean().optional(),
  })
  .strict();

router.patch('/me', requireAuth, async (req, res, next) => {
  try {
    const body = updateSchema.parse(req.body);

    if (Object.keys(body).length === 0) {
      return res.status(400).json({ error: 'No hay datos para actualizar' });
    }

    const patch = {
      user_id: req.user.id,
      ...(body.emailNotifications !== undefined ? { email_notifications: body.emailNotifications } : {}),
      ...(body.pushNotifications !== undefined ? { push_notifications: body.pushNotifications } : {}),
      ...(body.twoFactorEnabled !== undefined ? { two_factor_enabled: body.twoFactorEnabled } : {}),
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from('user_settings')
      .upsert(patch, { onConflict: 'user_id' })
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    return res.json({ settings: data });
  } catch (err) {
    return next(err);
  }
});

export default router;
