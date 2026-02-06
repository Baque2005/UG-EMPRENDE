import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase.js';
import { requireAuth, requireRole } from '../middlewares/auth.js';
import { parseDataUrl, guessFileExtFromMime } from '../utils/dataUrl.js';
import { randomUUID } from 'crypto';
import { notifyAdmins } from '../utils/notifyAdmins.js';

const router = Router();

async function uploadDataUrlToStorage({ bucket, folder, dataUrl }) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return null;

  const ext = guessFileExtFromMime(parsed.mimeType);
  const filePath = `${folder}/${Date.now()}_${randomUUID()}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from(bucket)
    .upload(filePath, parsed.buffer, { contentType: parsed.mimeType });

  if (uploadError) throw uploadError;

  const { data } = supabase.storage.from(bucket).getPublicUrl(filePath);
  return data.publicUrl;
}

router.get('/', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('businesses')
      .select('id, name, description, category, logo_url, banner_url, phone, email, instagram, rating, total_sales, joined_date, owner_id');

    if (error) return res.status(400).json({ error: error.message });
    // Attempt to include the owner's default delivery address (if any)
    try {
      const ownerIds = Array.from(new Set((data || []).map((b) => b.owner_id).filter(Boolean)));
      if (ownerIds.length > 0) {
        const { data: addresses } = await supabase
          .from('delivery_addresses')
          .select('user_id, label, address, city, phone')
          .in('user_id', ownerIds)
          .eq('is_default', true);

        const addrMap = (addresses || []).reduce((acc, a) => {
          acc[a.user_id] = a;
          return acc;
        }, {});

        const enriched = (data || []).map((b) => ({
          ...b,
          address: addrMap[b.owner_id]?.address ?? null,
          addressLabel: addrMap[b.owner_id]?.label ?? null,
          addressCity: addrMap[b.owner_id]?.city ?? null,
          addressPhone: addrMap[b.owner_id]?.phone ?? null,
        }));

        return res.json(enriched);
      }
    } catch (e) {
      // ignore address enrichment failures
    }

    return res.json(data);
  } catch (err) {
    return next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data: business, error } = await supabase
      .from('businesses')
      .select('*')
      .eq('id', id)
      .single();

    if (error) return res.status(404).json({ error: 'Negocio no encontrado' });

    // Attach owner's default delivery address if available
    try {
      if (business?.owner_id) {
        const { data: addr } = await supabase
          .from('delivery_addresses')
          .select('label, address, city, phone')
          .eq('user_id', business.owner_id)
          .eq('is_default', true)
          .limit(1)
          .maybeSingle();

        if (addr) {
          business.address = addr.address;
          business.addressLabel = addr.label;
          business.addressCity = addr.city;
          business.addressPhone = addr.phone;
        }
      }
    } catch (e) {
      // ignore
    }

    const { data: products } = await supabase
      .from('products')
      .select('*')
      .eq('business_id', id);

    return res.json({ ...business, products: products || [] });
  } catch (err) {
    return next(err);
  }
});

// Ratings
const upsertRatingSchema = z
  .object({
    rating: z.coerce.number().int().min(1).max(5),
    comment: z.string().optional(),
  })
  .strict();

async function getBusinessRatingSummary(businessId) {
  // Obtener todas las calificaciones y calcular promedio en JS
  const { data: ratings, error } = await supabase
    .from('business_ratings')
    .select('rating')
    .eq('business_id', businessId);

  if (error) throw error;
  const ratingCount = Array.isArray(ratings) ? ratings.length : 0;
  const sum = Array.isArray(ratings) ? ratings.reduce((acc, r) => acc + (Number(r.rating) || 0), 0) : 0;
  const avg = ratingCount > 0 ? sum / ratingCount : 0;
  return {
    rating: Number(avg.toFixed(2)),
    ratingCount,
  };
}

router.get('/:id/ratings/summary', async (req, res, next) => {
  try {
    const { id } = req.params;
    const summary = await getBusinessRatingSummary(id);
    return res.json(summary);
  } catch (err) {
    return next(err);
  }
});

router.get('/:id/ratings/me', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('business_ratings')
      .select('rating, comment, created_at, updated_at')
      .eq('business_id', id)
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (error) return res.status(400).json({ error: error.message });
    return res.json({ rating: data?.rating ?? null, comment: data?.comment ?? '' });
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/ratings', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const body = upsertRatingSchema.parse(req.body);

    // Validar que negocio exista y evitar auto-calificación del dueño
    const { data: biz, error: bizErr } = await supabase
      .from('businesses')
      .select('id, owner_id')
      .eq('id', id)
      .single();

    if (bizErr || !biz) return res.status(404).json({ error: 'Negocio no encontrado' });
    if (biz.owner_id === req.user.id) return res.status(403).json({ error: 'No puedes calificar tu propio negocio' });

    // Bloquear admin calificando
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', req.user.id)
      .maybeSingle();
    if (profile?.role === 'admin') return res.status(403).json({ error: 'El admin no califica negocios' });

    const now = new Date().toISOString();

    const { data: row, error } = await supabase
      .from('business_ratings')
      .upsert(
        {
          business_id: id,
          user_id: req.user.id,
          rating: body.rating,
          comment: body.comment || null,
          updated_at: now,
        },
        { onConflict: 'business_id,user_id' },
      )
      .select('rating')
      .single();

    if (error) return res.status(400).json({ error: error.message });

    // Recalcular promedio y actualizar businesses.rating
    const summary = await getBusinessRatingSummary(id);
    await supabase.from('businesses').update({ rating: summary.rating }).eq('id', id);

    return res.status(201).json({
      rating: row?.rating ?? body.rating,
      summary,
    });
  } catch (err) {
    return next(err);
  }
});

const createBusinessSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().default(''),
  category: z.string().min(1),
  phone: z.string().optional().default(''),
  email: z.string().email().optional(),
  instagram: z.string().optional().default(''),
  logo: z.string().optional(),
  banner: z.string().optional(),
});

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const body = createBusinessSchema.parse(req.body);

    // Permitir: entrepreneur crea negocio; customer puede "upgradear" a entrepreneur al crear negocio.
    // Admin no debería necesitarlo, pero lo dejamos pasar.
    const { data: profile, error: profileErr } = await supabase
      .from('profiles')
      .select('role, business_id')
      .eq('id', req.user.id)
      .single();

    if (profileErr || !profile) return res.status(403).json({ error: 'Acceso denegado' });
    if (!['customer', 'entrepreneur', 'admin'].includes(profile.role)) {
      return res.status(403).json({ error: 'Permisos insuficientes' });
    }

    if (profile.business_id) {
      return res.status(409).json({ error: 'Ya tienes un negocio registrado' });
    }

    const logoUrl = body.logo?.startsWith('data:')
      ? await uploadDataUrlToStorage({ bucket: 'business-assets', folder: 'logos', dataUrl: body.logo })
      : body.logo || null;

    const bannerUrl = body.banner?.startsWith('data:')
      ? await uploadDataUrlToStorage({ bucket: 'business-assets', folder: 'banners', dataUrl: body.banner })
      : body.banner || null;

    const { data, error } = await supabase
      .from('businesses')
      .insert([
        {
          owner_id: req.user.id,
          name: body.name,
          description: body.description,
          category: body.category,
          phone: body.phone,
          email: body.email || req.user.email,
          instagram: body.instagram,
          logo_url: logoUrl,
          banner_url: bannerUrl,
        },
      ])
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    // Vincular negocio al perfil + upgrade de rol si venía como customer
    const patch = {
      business_id: data.id,
      ...(profile.role === 'customer' ? { role: 'entrepreneur' } : {}),
    };
    await supabase.from('profiles').update(patch).eq('id', req.user.id);

    // Notificar admins
    await notifyAdmins({
      title: 'Nuevo negocio creado',
      message: `Se creó el negocio "${data?.name || body.name}".`,
      meta: { kind: 'business', action: 'created', businessId: data?.id, ownerUserId: req.user.id },
    });

    return res.status(201).json({ business: data, upgraded: profile.role === 'customer' });
  } catch (err) {
    return next(err);
  }
});

const updateBusinessSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    category: z.string().min(1).optional(),
    phone: z.string().optional(),
    email: z.string().email().optional(),
    instagram: z.string().optional(),
    logo: z.string().optional(),
    banner: z.string().optional(),
  })
  .strict();

router.patch('/:id', requireAuth, requireRole(['entrepreneur', 'admin']), async (req, res, next) => {
  try {
    const { id } = req.params;
    const body = updateBusinessSchema.parse(req.body);

    const { data: existing, error: findErr } = await supabase
      .from('businesses')
      .select('id, owner_id')
      .eq('id', id)
      .single();

    if (findErr || !existing) return res.status(404).json({ error: 'Negocio no encontrado' });

    const isAdmin = req.profile?.role === 'admin';
    if (!isAdmin && existing.owner_id !== req.user.id) {
      return res.status(403).json({ error: 'No eres dueño del negocio' });
    }

    if (Object.keys(body).length === 0) {
      return res.status(400).json({ error: 'No hay datos para actualizar' });
    }

    const patch = { ...body };

    if (typeof body.logo === 'string' && body.logo.startsWith('data:')) {
      patch.logo_url = await uploadDataUrlToStorage({ bucket: 'business-assets', folder: 'logos', dataUrl: body.logo });
      delete patch.logo;
    }

    if (typeof body.banner === 'string' && body.banner.startsWith('data:')) {
      patch.banner_url = await uploadDataUrlToStorage({ bucket: 'business-assets', folder: 'banners', dataUrl: body.banner });
      delete patch.banner;
    }

    // Permitir compatibilidad con frontend que manda logo/banner como campos directos
    if (typeof body.logo === 'string' && !body.logo.startsWith('data:')) {
      patch.logo_url = body.logo;
      delete patch.logo;
    }

    if (typeof body.banner === 'string' && !body.banner.startsWith('data:')) {
      patch.banner_url = body.banner;
      delete patch.banner;
    }

    const allowedPatch = {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.category !== undefined ? { category: patch.category } : {}),
      ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
      ...(patch.email !== undefined ? { email: patch.email } : {}),
      ...(patch.instagram !== undefined ? { instagram: patch.instagram } : {}),
      ...(patch.logo_url !== undefined ? { logo_url: patch.logo_url } : {}),
      ...(patch.banner_url !== undefined ? { banner_url: patch.banner_url } : {}),
    };

    const { data, error } = await supabase.from('businesses').update(allowedPatch).eq('id', id).select().single();
    if (error) return res.status(400).json({ error: error.message });

    return res.json({ business: data });
  } catch (err) {
    return next(err);
  }
});

router.delete('/:id', requireAuth, requireRole(['admin']), async (req, res, next) => {
  try {
    const { id } = req.params;

    // 1) Eliminar órdenes del negocio (y sus items) para evitar FK orders_business_id_fkey
    try {
      const { data: bizOrders, error: bizOrdersErr } = await supabase
        .from('orders')
        .select('id')
        .eq('business_id', id);

      if (!bizOrdersErr && Array.isArray(bizOrders) && bizOrders.length > 0) {
        const ids = bizOrders.map((o) => o.id);
        await supabase.from('order_items').delete().in('order_id', ids);
        await supabase.from('orders').delete().in('id', ids);
      }
    } catch {
      // ignore best-effort
    }

    // 2) Eliminar productos del negocio
    try {
      await supabase.from('products').delete().eq('business_id', id);
    } catch {
      // ignore
    }

    // 3) Eliminar calificaciones del negocio
    try {
      await supabase.from('business_ratings').delete().eq('business_id', id);
    } catch {
      // ignore
    }

    // 4) Desvincular perfiles que apunten a este negocio (evita referencias colgantes)
    try {
      await supabase.from('profiles').update({ business_id: null }).eq('business_id', id);
    } catch {
      // ignore
    }

    // 5) Finalmente borrar el negocio
    const { error } = await supabase.from('businesses').delete().eq('id', id);
    if (error) return res.status(400).json({ error: error.message });
    return res.json({ message: 'Negocio eliminado' });
  } catch (err) {
    return next(err);
  }
});

// Convert current entrepreneur -> customer: remove their business and downgrade role
router.post('/me/convert-to-customer', requireAuth, requireRole(['entrepreneur']), async (req, res, next) => {
  try {
    // Find business owned by current user
    const { data: biz, error: bizErr } = await supabase
      .from('businesses')
      .select('id')
      .eq('owner_id', req.user.id)
      .limit(1)
      .maybeSingle();

    if (bizErr) return res.status(400).json({ error: bizErr.message });
    if (!biz || !biz.id) {
      // No business: still allow role change
      await supabase.from('profiles').update({ role: 'customer', business_id: null }).eq('id', req.user.id);
      return res.json({ message: 'Ya no eres emprendedor', downgraded: true });
    }

    const id = biz.id;

    // 1) Eliminar órdenes del negocio (y sus items)
    try {
      const { data: bizOrders } = await supabase.from('orders').select('id').eq('business_id', id);
      if (Array.isArray(bizOrders) && bizOrders.length > 0) {
        const ids = bizOrders.map((o) => o.id);
        await supabase.from('order_items').delete().in('order_id', ids);
        await supabase.from('orders').delete().in('id', ids);
      }
    } catch {}

    // 2) Eliminar productos del negocio
    try {
      await supabase.from('products').delete().eq('business_id', id);
    } catch {}

    // 3) Eliminar calificaciones del negocio
    try {
      await supabase.from('business_ratings').delete().eq('business_id', id);
    } catch {}

    // 4) Desvincular perfiles que apunten a este negocio
    try {
      await supabase.from('profiles').update({ business_id: null }).eq('business_id', id);
    } catch {}

    // 5) Finalmente borrar el negocio
    try {
      await supabase.from('businesses').delete().eq('id', id);
    } catch (e) {
      // best-effort
    }

    // 6) Downgrade del rol del usuario que pidió la conversión
    await supabase.from('profiles').update({ role: 'customer', business_id: null }).eq('id', req.user.id);

    // Notificar administradores
    try {
      await notifyAdmins({
        title: 'Negocio eliminado por su dueño',
        message: `El usuario ${req.user.email || req.user.id} convirtió su cuenta a cliente y su negocio fue eliminado.`,
        meta: { kind: 'business', action: 'owner_deleted', ownerUserId: req.user.id },
      });
    } catch {}

    return res.json({ message: 'Negocio eliminado y rol convertido a cliente', downgraded: true });
  } catch (err) {
    return next(err);
  }
});

export default router;
