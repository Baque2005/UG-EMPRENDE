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

    // 0) Obtener business_id (si existe) antes de borrar perfil
    let businessId = null;
    try {
      const { data: profile } = await supabase
        .from('profiles')
        .select('business_id')
        .eq('id', id)
        .maybeSingle();

      businessId = profile?.business_id || null;
    } catch {
      businessId = null;
    }

    // Fallback: si no está en profiles, intentar resolver por owner_id
    if (!businessId) {
      try {
        const { data: biz } = await supabase
          .from('businesses')
          .select('id')
          .eq('owner_id', id)
          .limit(1)
          .maybeSingle();
        businessId = biz?.id || null;
      } catch {
        businessId = null;
      }
    }

    // 1) Si el usuario tiene emprendimiento, eliminarlo primero (con dependencias)
    if (businessId) {
      // Orders del negocio -> order_items -> orders
      try {
        const { data: bizOrders, error: bizOrdersErr } = await supabase
          .from('orders')
          .select('id')
          .eq('business_id', businessId);

        if (!bizOrdersErr && Array.isArray(bizOrders) && bizOrders.length > 0) {
          const ids = bizOrders.map((o) => o.id);
          await supabase.from('order_items').delete().in('order_id', ids);
          await supabase.from('orders').delete().in('id', ids);
        }
      } catch {
        // ignore best-effort
      }

      // Productos del negocio
      try {
        await supabase.from('products').delete().eq('business_id', businessId);
      } catch {
        // ignore best-effort
      }

      // Ratings del negocio
      try {
        await supabase.from('business_ratings').delete().eq('business_id', businessId);
      } catch {
        // ignore best-effort
      }

      // Eliminar negocio
      const { error: bizDelErr } = await supabase.from('businesses').delete().eq('id', businessId);
      if (bizDelErr) return res.status(400).json({ error: `No se pudo eliminar el emprendimiento: ${bizDelErr.message}` });
    }

    // 2) Limpieza best-effort de datos ligados al usuario
    try {
      await Promise.allSettled([
        supabase.from('notifications').delete().eq('user_id', id),
        supabase.from('payment_methods').delete().eq('user_id', id),
        supabase.from('delivery_addresses').delete().eq('user_id', id),
        supabase.from('user_settings').delete().eq('user_id', id),
        supabase.from('favorites').delete().eq('user_id', id),
        supabase.from('push_subscriptions').delete().eq('user_id', id),
        // Reportes donde fue quien reportó o el dueño afectado
        supabase.from('reports').delete().or(`reporter_id.eq.${id},owner_user_id.eq.${id}`),
        // Reportes cuyo target es el usuario
        supabase.from('reports').delete().eq('type', 'user').eq('target_id', id),
      ]);
    } catch {
      // ignore
    }

    // Orders del usuario (customer) -> order_items -> orders
    try {
      const { data: userOrders, error: ordersErr } = await supabase.from('orders').select('id').eq('customer_id', id);
      if (!ordersErr && Array.isArray(userOrders) && userOrders.length > 0) {
        const ids = userOrders.map((o) => o.id);
        await supabase.from('order_items').delete().in('order_id', ids);
        await supabase.from('orders').delete().in('id', ids);
      }
    } catch {
      // ignore
    }

    // 3) borrar profile (si existe)
    await supabase.from('profiles').delete().eq('id', id);

    // 4) borrar usuario de Supabase Auth (service role)
    const { error: authErr } = await supabase.auth.admin.deleteUser(id);
    if (authErr) return res.status(400).json({ error: authErr.message });

    return res.json({ message: businessId ? 'Usuario y emprendimiento eliminados' : 'Usuario eliminado' });
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
