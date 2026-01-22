import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase.js';
import { createNotification } from '../utils/createNotification.js';
import { requireAuth, requireRole } from '../middlewares/auth.js';
import { notifyAdmins } from '../utils/notifyAdmins.js';

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

const router = Router();

const createReportSchema = z.object({
  type: z.enum(['product', 'business', 'user']),
  targetId: z.string().min(1),
  targetName: z.string().optional().default(''),
  reason: z.string().min(3),
});

async function findOwnerUserId({ type, targetId }) {
  if (type === 'product') {
    const { data: product } = await supabase
      .from('products')
      .select('business_id')
      .eq('id', targetId)
      .single();

    if (!product?.business_id) return null;

    const { data: biz } = await supabase
      .from('businesses')
      .select('owner_id')
      .eq('id', product.business_id)
      .single();

    return biz?.owner_id || null;
  }

  if (type === 'business') {
    const { data: biz } = await supabase
      .from('businesses')
      .select('owner_id')
      .eq('id', targetId)
      .single();

    return biz?.owner_id || null;
  }

  if (type === 'user') return targetId;

  return null;
}

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const body = createReportSchema.parse(req.body);

    const ownerUserId = await findOwnerUserId({ type: body.type, targetId: body.targetId });

    const now = new Date().toISOString();

    const { data: report, error } = await supabase
      .from('reports')
      .insert([
        {
          type: body.type,
          target_id: body.targetId,
          target_name: body.targetName,
          reason: body.reason,
          reporter_id: req.user.id,
          status: 'pending',
          owner_user_id: ownerUserId,
          reported_at: now,
        },
      ])
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    // Notificar admins reales
    await notifyAdmins({
      title: 'Nuevo reporte recibido',
      message: `Se reportó ${body.type}${body.targetName ? `: ${body.targetName}` : ''}.`,
      meta: { kind: 'report', action: 'created', reportId: report.id, url: `${FRONTEND_URL}/admin`, ctaLabel: 'Ver reportes' },
      createdAt: now,
    });

    // Notificar dueño
    if (ownerUserId && ownerUserId !== req.user.id) {
      try {
        let url;
        if (body.type === 'product') url = `${FRONTEND_URL}/product/${body.targetId}`;
        else if (body.type === 'business') url = `${FRONTEND_URL}/business/${body.targetId}`;
        else if (body.type === 'user') url = `${FRONTEND_URL}/profile?user=${body.targetId}`;

        await createNotification({
          userId: ownerUserId,
          title: 'Se reportó un elemento tuyo',
          message: `${body.targetName ? `"${body.targetName}"` : 'Un elemento'} fue reportado. Razón: ${body.reason}`,
          meta: { kind: 'report', action: 'received', reportId: report.id, url, ctaLabel: 'Ver elemento' },
          createdAt: now,
        });
      } catch {
        // best-effort
      }
    }

    // Notificar al que reportó
    try {
      await createNotification({
        userId: req.user.id,
        title: 'Reporte enviado',
        message: 'Tu reporte fue enviado al administrador.',
        meta: { kind: 'report', action: 'submitted', reportId: report.id },
        createdAt: now,
      });
    } catch {
      // best-effort
    }

    return res.status(201).json({ report });
  } catch (err) {
    return next(err);
  }
});

router.get('/', requireAuth, requireRole(['admin']), async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('reports')
      .select('*')
      .order('reported_at', { ascending: false });

    if (error) return res.status(400).json({ error: error.message });
    return res.json(data);
  } catch (err) {
    return next(err);
  }
});

const updateStatusSchema = z.object({
  status: z.enum(['pending', 'reviewing', 'resolved', 'rejected']),
});

router.patch('/:id/status', requireAuth, requireRole(['admin']), async (req, res, next) => {
  try {
    const { id } = req.params;
    const body = updateStatusSchema.parse(req.body);

    const { data, error } = await supabase
      .from('reports')
      .update({ status: body.status })
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    return res.json({ report: data });
  } catch (err) {
    return next(err);
  }
});

router.delete('/:id', requireAuth, requireRole(['admin']), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from('reports').delete().eq('id', id);
    if (error) return res.status(400).json({ error: error.message });
    return res.json({ message: 'Reporte eliminado' });
  } catch (err) {
    return next(err);
  }
});

export default router;
