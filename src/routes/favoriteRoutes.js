import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase.js';
import { requireAuth } from '../middlewares/auth.js';

const router = Router();

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('favorites')
      .select('product_id')
      .eq('user_id', req.user.id);

    if (error) return res.status(400).json({ error: error.message });
    const ids = Array.isArray(data) ? data.map((r) => r.product_id) : [];
    return res.json(ids);
  } catch (err) {
    return next(err);
  }
});

const replaceSchema = z.object({ productIds: z.array(z.string()).optional() }).strict();

router.put('/me', requireAuth, async (req, res, next) => {
  try {
    const body = replaceSchema.parse(req.body);
    const ids = Array.isArray(body.productIds) ? body.productIds : [];

    // Delete existing
    const { error: delErr } = await supabase.from('favorites').delete().eq('user_id', req.user.id);
    if (delErr) {
      // continue even if delete fails
      console.warn('favorites delete error:', delErr.message || delErr);
    }

    if (ids.length === 0) return res.json([]);

    const rows = ids.map((pid) => ({ user_id: req.user.id, product_id: pid }));
    const { data, error } = await supabase.from('favorites').insert(rows).select('product_id');
    if (error) return res.status(400).json({ error: error.message });
    return res.json(Array.isArray(data) ? data.map((r) => r.product_id) : []);
  } catch (err) {
    return next(err);
  }
});

export default router;
