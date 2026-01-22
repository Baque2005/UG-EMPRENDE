import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase.js';
import { createNotification } from '../utils/createNotification.js';
import { requireAuth, requireRole } from '../middlewares/auth.js';

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

const router = Router();

const createOrderSchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.string().min(1),
        quantity: z.coerce.number().int().positive(),
      }),
    )
    .min(1),
  delivery: z.any().optional(),
  payment: z.any().optional(),
  notes: z.string().optional().default(''),
  contact: z
    .object({
      name: z.string().min(1),
      email: z.string().email(),
      phone: z.string().min(1),
    })
    .optional(),
});

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const body = createOrderSchema.parse(req.body);

    const productIds = body.items.map((i) => i.productId);

    const { data: products, error: productsError } = await supabase
      .from('products')
      .select('id, business_id, price')
      .in('id', productIds);

    if (productsError) return res.status(400).json({ error: productsError.message });
    if (!products || products.length !== productIds.length) {
      return res.status(400).json({ error: 'Uno o más productos no existen' });
    }

    const businessId = products[0].business_id;
    const sameBusiness = products.every((p) => p.business_id === businessId);
    if (!sameBusiness) return res.status(400).json({ error: 'Los items deben ser del mismo negocio' });

    const priceById = new Map(products.map((p) => [p.id, Number(p.price)]));

    const orderTotal = body.items.reduce((sum, item) => {
      const price = priceById.get(item.productId);
      return sum + (price || 0) * item.quantity;
    }, 0);

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .insert([
        {
          customer_id: req.user.id,
          business_id: businessId,
          total: orderTotal,
          status: 'pending',
          payment_method: body.payment?.type || null,
          payment: body.payment || null,
          delivery: body.delivery || null,
          contact: body.contact || null,
          notes: body.notes,
        },
      ])
      .select()
      .single();

    if (orderError) return res.status(400).json({ error: orderError.message });

    const itemsRows = body.items.map((i) => ({
      order_id: order.id,
      product_id: i.productId,
      quantity: i.quantity,
      price: priceById.get(i.productId) || 0,
    }));

    const { error: itemsError } = await supabase.from('order_items').insert(itemsRows);
    if (itemsError) return res.status(400).json({ error: itemsError.message });

    // Notificaciones (best-effort)
    try {
      const { data: biz } = await supabase
        .from('businesses')
        .select('id, owner_id, name')
        .eq('id', businessId)
        .single();

      const notificationsToInsert = [];

      if (biz?.owner_id) {
        notificationsToInsert.push({
          user_id: biz.owner_id,
          title: 'Nuevo pedido recibido',
          message: `Tienes un nuevo pedido pendiente${biz?.name ? ` en ${biz.name}` : ''}.`,
          meta: { kind: 'order', action: 'new', orderId: order.id, businessId, url: `${FRONTEND_URL}/dashboard?tab=orders`, ctaLabel: 'Ver pedidos' },
        });
      }

      notificationsToInsert.push({
        user_id: req.user.id,
        title: 'Pedido creado',
        message: 'Tu pedido fue creado exitosamente. Puedes verlo en tus pedidos.',
        meta: { kind: 'order', action: 'created', orderId: order.id, businessId, url: `${FRONTEND_URL}/profile?tab=orders`, ctaLabel: 'Ver pedido' },
      });

      if (notificationsToInsert.length > 0) {
        for (const n of notificationsToInsert) {
          try {
            await createNotification({ userId: n.user_id, title: n.title, message: n.message, meta: n.meta, createdAt: n.created_at });
          } catch {
            // best-effort
          }
        }
      }
    } catch {
      // silencioso
    }

    const { data: fullOrder, error: fetchErr } = await supabase
      .from('orders')
      .select('*, order_items(*)')
      .eq('id', order.id)
      .single();

    if (fetchErr) {
      return res.status(201).json({ orderId: order.id, total: orderTotal });
    }

    return res.status(201).json({ orderId: order.id, total: orderTotal, order: fullOrder });
  } catch (err) {
    return next(err);
  }
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*, order_items(*)')
      .eq('customer_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) return res.status(400).json({ error: error.message });
    return res.json(data);
  } catch (err) {
    return next(err);
  }
});

router.get('/business/:businessId', requireAuth, requireRole(['entrepreneur', 'admin']), async (req, res, next) => {
  try {
    const { businessId } = req.params;

    const { data: biz, error: bizErr } = await supabase
      .from('businesses')
      .select('id, owner_id')
      .eq('id', businessId)
      .single();

    if (bizErr || !biz) return res.status(404).json({ error: 'Negocio no encontrado' });

    const isAdmin = req.profile?.role === 'admin';
    if (!isAdmin && biz.owner_id !== req.user.id) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const { data, error } = await supabase
      .from('orders')
      .select('*, order_items(*)')
      .eq('business_id', businessId)
      .order('created_at', { ascending: false });

    if (error) return res.status(400).json({ error: error.message });
    return res.json(data);
  } catch (err) {
    return next(err);
  }
});

const statusSchema = z.object({
  status: z.enum(['pending', 'confirmed', 'preparing', 'ready', 'delivered', 'cancelled']),
});

router.patch('/:id/status', requireAuth, requireRole(['entrepreneur', 'admin']), async (req, res, next) => {
  try {
    const { id } = req.params;
    const body = statusSchema.parse(req.body);

    const { data: order, error: findErr } = await supabase
      .from('orders')
      .select('id, business_id, customer_id, status')
      .eq('id', id)
      .single();

    if (findErr || !order) return res.status(404).json({ error: 'Orden no encontrada' });

    const { data: biz } = await supabase
      .from('businesses')
      .select('id, owner_id')
      .eq('id', order.business_id)
      .single();

    const isAdmin = req.profile?.role === 'admin';
    if (!isAdmin && biz?.owner_id !== req.user.id) return res.status(403).json({ error: 'No autorizado' });

    const { data, error } = await supabase
      .from('orders')
      .update({ status: body.status })
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    // Notificar al cliente del cambio de estado (best-effort)
    try {
      if (order?.customer_id) {
        await createNotification({
          userId: order.customer_id,
          title: 'Estado de tu pedido actualizado',
          message: `Tu pedido ahora está: ${body.status}`,
          meta: { kind: 'order', action: 'status', orderId: id, status: body.status, url: `${FRONTEND_URL}/profile?tab=orders`, ctaLabel: 'Ver pedido' },
        });
      }
    } catch {
      // silencioso
    }

    // Incrementar ventas del negocio cuando el pedido se entrega por primera vez (best-effort)
    try {
      const prevStatus = String(order?.status || '').toLowerCase();
      const nextStatus = String(body.status || '').toLowerCase();

      if (prevStatus !== 'delivered' && nextStatus === 'delivered' && order?.business_id) {
        const { data: biz } = await supabase
          .from('businesses')
          .select('id, total_sales')
          .eq('id', order.business_id)
          .single();

        const currentSales = typeof biz?.total_sales === 'number' ? biz.total_sales : Number(biz?.total_sales) || 0;
        await supabase
          .from('businesses')
          .update({ total_sales: currentSales + 1 })
          .eq('id', order.business_id);
      }
    } catch {
      // silencioso
    }

    return res.json({ order: data });
  } catch (err) {
    return next(err);
  }
});

router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data: order, error: findErr } = await supabase
      .from('orders')
      .select('id, customer_id')
      .eq('id', id)
      .single();

    if (findErr || !order) return res.status(404).json({ error: 'Orden no encontrada' });

    // Solo el dueño (cliente) o admin
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', req.user.id)
      .single();

    const isAdmin = profile?.role === 'admin';
    if (!isAdmin && order.customer_id !== req.user.id) return res.status(403).json({ error: 'No autorizado' });

    await supabase.from('order_items').delete().eq('order_id', id);

    const { error } = await supabase.from('orders').delete().eq('id', id);
    if (error) return res.status(400).json({ error: error.message });

    return res.json({ message: 'Orden eliminada' });
  } catch (err) {
    return next(err);
  }
});

export default router;
