import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase.js';
import { requireAuth } from '../middlewares/auth.js';

const router = Router();

const createSchema = z.object({
  label: z.string().min(1),
  address: z.string().min(3),
  city: z.string().min(2),
  phone: z.string().min(6).optional().default(''),
  isDefault: z.boolean().optional(),
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('delivery_addresses')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) return res.status(400).json({ error: error.message });
    return res.json(data || []);
  } catch (err) {
    return next(err);
  }
});

router.post('/me', requireAuth, async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body);

    const { data: existing } = await supabase
      .from('delivery_addresses')
      .select('id')
      .eq('user_id', req.user.id)
      .limit(1);

    const makeDefault = body.isDefault ?? (!existing || existing.length === 0);

    if (makeDefault) {
      await supabase
        .from('delivery_addresses')
        .update({ is_default: false })
        .eq('user_id', req.user.id);
    }

    const { data, error } = await supabase
      .from('delivery_addresses')
      .insert([
        {
          user_id: req.user.id,
          label: body.label,
          address: body.address,
          city: body.city,
          phone: body.phone,
          is_default: makeDefault,
        },
      ])
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    return res.status(201).json({ address: data });
  } catch (err) {
    return next(err);
  }
});

const updateSchema = z
  .object({
    label: z.string().min(1).optional(),
    address: z.string().min(3).optional(),
    city: z.string().min(2).optional(),
    phone: z.string().min(6).optional(),
    isDefault: z.boolean().optional(),
  })
  .strict();

router.patch('/me/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const body = updateSchema.parse(req.body);

    if (Object.keys(body).length === 0) {
      return res.status(400).json({ error: 'No hay datos para actualizar' });
    }

    if (body.isDefault === true) {
      await supabase
        .from('delivery_addresses')
        .update({ is_default: false })
        .eq('user_id', req.user.id);
    }

    const patch = {
      ...(body.label !== undefined ? { label: body.label } : {}),
      ...(body.address !== undefined ? { address: body.address } : {}),
      ...(body.city !== undefined ? { city: body.city } : {}),
      ...(body.phone !== undefined ? { phone: body.phone } : {}),
      ...(body.isDefault !== undefined ? { is_default: body.isDefault } : {}),
    };

    const { data, error } = await supabase
      .from('delivery_addresses')
      .update(patch)
      .eq('id', id)
      .eq('user_id', req.user.id)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    return res.json({ address: data });
  } catch (err) {
    return next(err);
  }
});

router.delete('/me/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data: deleted, error } = await supabase
      .from('delivery_addresses')
      .delete()
      .eq('id', id)
      .eq('user_id', req.user.id)
      .select('id, is_default')
      .maybeSingle();

    if (error) return res.status(400).json({ error: error.message });

    if (deleted?.is_default) {
      const { data: nextDefault } = await supabase
        .from('delivery_addresses')
        .select('id')
        .eq('user_id', req.user.id)
        .order('created_at', { ascending: false })
        .limit(1);

      const nextId = nextDefault?.[0]?.id;
      if (nextId) {
        await supabase
          .from('delivery_addresses')
          .update({ is_default: true })
          .eq('id', nextId)
          .eq('user_id', req.user.id);
      }
    }

    return res.json({ message: 'Dirección eliminada' });
  } catch (err) {
    return next(err);
  }
});

export default router;
