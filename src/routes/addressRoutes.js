import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase.js';
import { requireAuth } from '../middlewares/auth.js';

const router = Router();

const createSchema = z.object({
  label: z.string().min(1),
  address: z.string().min(3),
  // city puede ser opcional en el perfil; si no se provee, se almacenará NULL/vacío
    city: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().min(2).optional()),
    phone: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().min(6).optional()).default(''),
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
          // Evitar insertar NULL en columnas que son NOT NULL en la BD.
          // Si `city` no fue provisto, guardamos cadena vacía.
          city: body.city !== undefined ? body.city : '',
          phone: body.phone !== undefined ? body.phone : '',
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
      city: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().min(2).optional()),
      phone: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().min(6).optional()),
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
      .select('id, is_default, address, phone')
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

    // Si el profile del usuario apuntaba a esta dirección, limpiamos los campos en profiles
    try {
      const { data: profile } = await supabase.from('profiles').select('address, phone').eq('id', req.user.id).maybeSingle();
      if (profile) {
        const sameAddress = deleted?.address && profile.address && String(profile.address).trim() === String(deleted.address).trim();
        const samePhone = deleted?.phone && profile.phone && String(profile.phone).trim() === String(deleted.phone).trim();
        const patch = {};
        if (sameAddress) patch.address = '';
        if (samePhone) patch.phone = '';
        if (Object.keys(patch).length > 0) {
          await supabase.from('profiles').update(patch).eq('id', req.user.id);
        }
      }
    } catch (e) {
      // best-effort: no bloquear el delete si falla la limpieza del profile
      console.warn('Failed to clear profile address/phone after delivery address delete', e?.message || e);
    }

    return res.json({ message: 'Dirección eliminada' });
  } catch (err) {
    return next(err);
  }
});

export default router;
