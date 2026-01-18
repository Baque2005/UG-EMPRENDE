import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase.js';
import { requireAuth } from '../middlewares/auth.js';

const router = Router();

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) return res.status(400).json({ error: error.message });
    return res.json(data);
  } catch (err) {
    return next(err);
  }
});

const createNotificationSchema = z
  .object({
    title: z.string().min(1),
    message: z.string().min(1),
    meta: z.any().optional(),
    dedupeKey: z.string().min(1).optional(),
  })
  .strict();

router.post('/me', requireAuth, async (req, res, next) => {
  try {
    const body = createNotificationSchema.parse(req.body);
    const now = new Date().toISOString();

    const meta = {
      ...(body.meta && typeof body.meta === 'object' ? body.meta : {}),
      ...(body.dedupeKey ? { dedupeKey: body.dedupeKey } : {}),
    };

    if (body.dedupeKey) {
      const { data: existing } = await supabase
        .from('notifications')
        .select('id')
        .eq('user_id', req.user.id)
        .eq('meta->>dedupeKey', body.dedupeKey)
        .limit(1);

      if (existing && existing.length > 0) {
        return res.status(200).json({ notification: null, deduped: true });
      }
    }

    const { data, error } = await supabase
      .from('notifications')
      .insert([
        {
          user_id: req.user.id,
          title: body.title,
          message: body.message,
          meta,
          read: false,
          created_at: now,
        },
      ])
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    return res.status(201).json({ notification: data });
  } catch (err) {
    return next(err);
  }
});

router.patch('/:id/read', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('notifications')
      .update({ read: true })
      .eq('id', id)
      .eq('user_id', req.user.id)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    return res.json({ notification: data });
  } catch (err) {
    return next(err);
  }
});

router.patch('/me/read-all', requireAuth, async (req, res, next) => {
  try {
    const { error } = await supabase
      .from('notifications')
      .update({ read: true })
      .eq('user_id', req.user.id);

    if (error) return res.status(400).json({ error: error.message });
    return res.json({ message: 'Todas marcadas como leídas' });
  } catch (err) {
    return next(err);
  }
});

router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from('notifications')
      .delete()
      .eq('id', id)
      .eq('user_id', req.user.id);

    if (error) return res.status(400).json({ error: error.message });
    return res.json({ message: 'Notificación eliminada' });
  } catch (err) {
    return next(err);
  }
});

export default router;
