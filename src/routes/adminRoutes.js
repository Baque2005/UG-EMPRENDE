import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase.js';
import { requireAuth, requireRole } from '../middlewares/auth.js';

const router = Router();

router.get('/users', requireAuth, requireRole(['admin']), async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, name, email, role, business_id, phone, faculty, created_at')
      .order('created_at', { ascending: false });

    if (error) return res.status(400).json({ error: error.message });
    return res.json(data || []);
  } catch (err) {
    return next(err);
  }
});

const updateUserSchema = z
  .object({
    role: z.enum(['customer', 'entrepreneur', 'admin']).optional(),
    name: z.string().min(1).optional(),
    phone: z.string().optional(),
    faculty: z.string().optional(),
  })
  .strict();

router.patch('/users/:id', requireAuth, requireRole(['admin']), async (req, res, next) => {
  try {
    const { id } = req.params;
    const body = updateUserSchema.parse(req.body);

    if (Object.keys(body).length === 0) {
      return res.status(400).json({ error: 'No hay datos para actualizar' });
    }

    const patch = {
      ...(body.role !== undefined ? { role: body.role } : {}),
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.phone !== undefined ? { phone: body.phone } : {}),
      ...(body.faculty !== undefined ? { faculty: body.faculty } : {}),
    };

    const { data, error } = await supabase
      .from('profiles')
      .update(patch)
      .eq('id', id)
      .select('id, name, email, role, business_id, phone, faculty, created_at')
      .single();

    if (error) return res.status(400).json({ error: error.message });
    return res.json({ user: data });
  } catch (err) {
    return next(err);
  }
});

router.delete('/users/:id', requireAuth, requireRole(['admin']), async (req, res, next) => {
  try {
    const { id } = req.params;

    // 1) borrar profile (si existe)
    await supabase.from('profiles').delete().eq('id', id);

    // 2) borrar usuario de Supabase Auth (service role)
    const { error: authErr } = await supabase.auth.admin.deleteUser(id);
    if (authErr) return res.status(400).json({ error: authErr.message });

    return res.json({ message: 'Usuario eliminado' });
  } catch (err) {
    return next(err);
  }
});

router.get('/orders', requireAuth, requireRole(['admin']), async (req, res, next) => {
  try {
    // Incluye order_items para ver productos/cantidades.
    const { data, error } = await supabase
      .from('orders')
      .select('*, order_items(*)')
      .order('created_at', { ascending: false });

    if (error) return res.status(400).json({ error: error.message });
    return res.json(data || []);
  } catch (err) {
    return next(err);
  }
});

export default router;
