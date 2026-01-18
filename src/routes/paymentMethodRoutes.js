import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase.js';
import { requireAuth } from '../middlewares/auth.js';

const router = Router();

const createSchema = z.object({
  type: z.enum(['paypal', 'cash']),
  label: z.string().min(1).optional(),
  email: z.string().email().optional(),
  isDefault: z.boolean().optional(),
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('payment_methods')
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

    if (body.type === 'paypal' && !body.email) {
      return res.status(400).json({ error: 'Email es requerido para PayPal' });
    }

    const { data: existing } = await supabase
      .from('payment_methods')
      .select('id')
      .eq('user_id', req.user.id)
      .limit(1);

    const makeDefault = body.isDefault ?? (!existing || existing.length === 0);

    if (makeDefault) {
      await supabase
        .from('payment_methods')
        .update({ is_default: false })
        .eq('user_id', req.user.id);
    }

    const { data, error } = await supabase
      .from('payment_methods')
      .insert([
        {
          user_id: req.user.id,
          type: body.type,
          label: body.label || (body.type === 'paypal' ? 'PayPal' : 'Efectivo'),
          email: body.type === 'paypal' ? body.email : null,
          is_default: makeDefault,
        },
      ])
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    return res.status(201).json({ paymentMethod: data });
  } catch (err) {
    return next(err);
  }
});

const updateSchema = z
  .object({
    label: z.string().min(1).optional(),
    email: z.string().email().optional(),
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
        .from('payment_methods')
        .update({ is_default: false })
        .eq('user_id', req.user.id);
    }

    const patch = {
      ...(body.label !== undefined ? { label: body.label } : {}),
      ...(body.email !== undefined ? { email: body.email } : {}),
      ...(body.isDefault !== undefined ? { is_default: body.isDefault } : {}),
    };

    const { data, error } = await supabase
      .from('payment_methods')
      .update(patch)
      .eq('id', id)
      .eq('user_id', req.user.id)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    return res.json({ paymentMethod: data });
  } catch (err) {
    return next(err);
  }
});

router.delete('/me/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data: deleted, error } = await supabase
      .from('payment_methods')
      .delete()
      .eq('id', id)
      .eq('user_id', req.user.id)
      .select('id, is_default')
      .maybeSingle();

    if (error) return res.status(400).json({ error: error.message });

    // Si se borró el default, intenta poner otro como default
    if (deleted?.is_default) {
      const { data: nextDefault } = await supabase
        .from('payment_methods')
        .select('id')
        .eq('user_id', req.user.id)
        .order('created_at', { ascending: false })
        .limit(1);

      const nextId = nextDefault?.[0]?.id;
      if (nextId) {
        await supabase
          .from('payment_methods')
          .update({ is_default: true })
          .eq('id', nextId)
          .eq('user_id', req.user.id);
      }
    }

    return res.json({ message: 'Método eliminado' });
  } catch (err) {
    return next(err);
  }
});

export default router;
