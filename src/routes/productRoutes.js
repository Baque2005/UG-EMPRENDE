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
    const { category, search, minPrice, maxPrice, featured } = req.query;

    let query = supabase.from('products').select('*');

    if (category) query = query.eq('category', String(category));
    if (featured === 'true') query = query.eq('featured', true);

    if (search) {
      query = query.or(`name.ilike.%${String(search)}%,description.ilike.%${String(search)}%`);
    }

    if (minPrice) query = query.gte('price', Number(minPrice));
    if (maxPrice) query = query.lte('price', Number(maxPrice));

    const { data, error } = await query;
    if (error) return res.status(400).json({ error: error.message });

    return res.json(data);
  } catch (err) {
    return next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data: product, error } = await supabase
      .from('products')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !product) return res.status(404).json({ error: 'Producto no encontrado' });

    const { data: business } = await supabase
      .from('businesses')
      .select('id, name, phone, email, instagram, category, logo_url, banner_url')
      .eq('id', product.business_id)
      .single();

    return res.json({
      ...product,
      business: business || null,
    });
  } catch (err) {
    return next(err);
  }
});

const createProductSchema = z.object({
  businessId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional().default(''),
  price: z.coerce.number().nonnegative(),
  category: z.string().min(1),
  stock: z.coerce.number().int().nonnegative().default(0),
  images: z.array(z.string()).optional(),
  image: z.string().optional(),
  acceptsDelivery: z.boolean().optional().default(true),
  acceptsPickup: z.boolean().optional().default(true),
  acceptsPaypal: z.boolean().optional().default(true),
  acceptsCash: z.boolean().optional().default(true),
  featured: z.boolean().optional().default(false),
});

router.post('/', requireAuth, requireRole(['entrepreneur']), async (req, res, next) => {
  try {
    const body = createProductSchema.parse(req.body);

    // Validar que el negocio sea del usuario
    const { data: biz, error: bizErr } = await supabase
      .from('businesses')
      .select('id, owner_id')
      .eq('id', body.businessId)
      .single();

    if (bizErr || !biz) return res.status(404).json({ error: 'Negocio no encontrado' });
    if (biz.owner_id !== req.user.id) return res.status(403).json({ error: 'No eres dueño del negocio' });

    // Validar método de pago y dirección de entrega
    const userId = req.user.id;
    const { data: paymentMethods, error: payErr } = await supabase
      .from('payment_methods')
      .select('id')
      .eq('user_id', userId);
    const { data: addresses, error: addrErr } = await supabase
      .from('delivery_addresses')
      .select('id')
      .eq('user_id', userId);

    if (payErr || addrErr) return res.status(500).json({ error: 'Error al validar requisitos' });
    if (!paymentMethods?.length && !addresses?.length) {
      return res.status(400).json({
        error: 'Debes agregar al menos un método de pago y una dirección de entrega antes de poder publicar productos.',
        missing: ['payment', 'address'],
      });
    }
    if (!paymentMethods?.length) {
      return res.status(400).json({
        error: 'Debes agregar al menos un método de pago antes de poder publicar productos.',
        missing: ['payment'],
      });
    }
    if (!addresses?.length) {
      return res.status(400).json({
        error: 'Debes agregar al menos una dirección de entrega antes de poder publicar productos.',
        missing: ['address'],
      });
    }

    const rawImages = Array.isArray(body.images) && body.images.length > 0
      ? body.images
      : body.image
        ? [body.image]
        : [];

    const limited = rawImages.filter(Boolean).slice(0, 6);

    const uploaded = [];
    for (const img of limited) {
      if (typeof img === 'string' && img.startsWith('data:')) {
        const url = await uploadDataUrlToStorage({ bucket: 'product-images', folder: 'items', dataUrl: img });
        if (url) uploaded.push(url);
      } else if (typeof img === 'string') {
        uploaded.push(img);
      }
    }

    const primary = uploaded[0] || null;

    const { data, error } = await supabase
      .from('products')
      .insert([
        {
          business_id: body.businessId,
          name: body.name,
          description: body.description,
          price: body.price,
          category: body.category,
          stock: body.stock,
          images: uploaded,
          image_url: primary,
          accepts_delivery: body.acceptsDelivery,
          accepts_pickup: body.acceptsPickup,
          accepts_paypal: body.acceptsPaypal,
          accepts_cash: body.acceptsCash,
          featured: body.featured,
        },
      ])
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    // Notificar admins
    await notifyAdmins({
      title: 'Nuevo producto creado',
      message: `Se creó el producto "${data?.name || body.name}".`,
      meta: { kind: 'product', action: 'created', productId: data?.id, businessId: body.businessId, ownerUserId: req.user.id },
    });

    return res.status(201).json({ product: data });
  } catch (err) {
    return next(err);
  }
});

// IMPORTANT: no usar defaults en update.
// Si usamos createProductSchema.partial(), los `.default()` se aplican aunque el campo no venga,
// y eso puede pisar valores existentes (ej: stock -> 0 al solo togglear featured).
const updateProductSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    price: z.coerce.number().nonnegative().optional(),
    category: z.string().min(1).optional(),
    stock: z.coerce.number().int().nonnegative().optional(),
    images: z.array(z.string()).optional(),
    image: z.string().optional(),
    acceptsDelivery: z.boolean().optional(),
    acceptsPickup: z.boolean().optional(),
    acceptsPaypal: z.boolean().optional(),
    acceptsCash: z.boolean().optional(),
    featured: z.boolean().optional(),
  })
  .strict();

router.patch('/:id', requireAuth, requireRole(['entrepreneur', 'admin']), async (req, res, next) => {
  try {
    const { id } = req.params;
    const body = updateProductSchema.parse(req.body);

    const { data: existing, error: findErr } = await supabase
      .from('products')
      .select('id, business_id')
      .eq('id', id)
      .single();

    if (findErr || !existing) return res.status(404).json({ error: 'Producto no encontrado' });

    const { data: biz } = await supabase
      .from('businesses')
      .select('id, owner_id')
      .eq('id', existing.business_id)
      .single();

    const isAdmin = req.profile?.role === 'admin';
    if (!isAdmin && biz?.owner_id !== req.user.id) return res.status(403).json({ error: 'No autorizado' });

    const patch = { ...body };

    if (body.images || body.image) {
      const rawImages = Array.isArray(body.images) && body.images.length > 0
        ? body.images
        : body.image
          ? [body.image]
          : [];

      const limited = rawImages.filter(Boolean).slice(0, 6);
      const uploaded = [];
      for (const img of limited) {
        if (typeof img === 'string' && img.startsWith('data:')) {
      // Validar método de pago y dirección de entrega
      const userId = req.user.id;
      const { data: paymentMethods, error: payErr } = await supabase
        .from('payment_methods')
        .select('id')
        .eq('user_id', userId);
      const { data: addresses, error: addrErr } = await supabase
        .from('delivery_addresses')
        .select('id')
        .eq('user_id', userId);

      if (payErr || addrErr) return res.status(500).json({ error: 'Error al validar requisitos' });
      if (!paymentMethods?.length && !addresses?.length) {
        return res.status(400).json({
          error: 'Debes agregar al menos un método de pago y una dirección de entrega antes de poder publicar productos.',
          missing: ['payment', 'address'],
        });
      }
      if (!paymentMethods?.length) {
        return res.status(400).json({
          error: 'Debes agregar al menos un método de pago antes de poder publicar productos.',
          missing: ['payment'],
        });
      }
      if (!addresses?.length) {
        return res.status(400).json({
          error: 'Debes agregar al menos una dirección de entrega antes de poder publicar productos.',
          missing: ['address'],
        });
      }
          const url = await uploadDataUrlToStorage({ bucket: 'product-images', folder: 'items', dataUrl: img });
          if (url) uploaded.push(url);
        } else if (typeof img === 'string') {
          uploaded.push(img);
        }
      }

      patch.images = uploaded;
      patch.image_url = uploaded[0] || null;
      delete patch.image;
    }

    // mapear flags a columnas
    if (typeof body.acceptsDelivery === 'boolean') {
      patch.accepts_delivery = body.acceptsDelivery;
      delete patch.acceptsDelivery;
    }
    if (typeof body.acceptsPickup === 'boolean') {
      patch.accepts_pickup = body.acceptsPickup;
      delete patch.acceptsPickup;
    }
    if (typeof body.acceptsPaypal === 'boolean') {
      patch.accepts_paypal = body.acceptsPaypal;
      delete patch.acceptsPaypal;
    }
    if (typeof body.acceptsCash === 'boolean') {
      patch.accepts_cash = body.acceptsCash;
      delete patch.acceptsCash;
    }

    const { data, error } = await supabase.from('products').update(patch).eq('id', id).select().single();
    if (error) return res.status(400).json({ error: error.message });

    return res.json({ product: data });
  } catch (err) {
    return next(err);
  }
});

router.delete('/:id', requireAuth, requireRole(['entrepreneur', 'admin']), async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data: existing, error: findErr } = await supabase
      .from('products')
      .select('id, business_id')
      .eq('id', id)
      .single();

    if (findErr || !existing) return res.status(404).json({ error: 'Producto no encontrado' });

    const { data: biz } = await supabase
      .from('businesses')
      .select('id, owner_id')
      .eq('id', existing.business_id)
      .single();

    const isAdmin = req.profile?.role === 'admin';
    if (!isAdmin && biz?.owner_id !== req.user.id) return res.status(403).json({ error: 'No autorizado' });

    const { error } = await supabase.from('products').delete().eq('id', id);
    if (error) return res.status(400).json({ error: error.message });

    return res.json({ message: 'Producto eliminado' });
  } catch (err) {
    return next(err);
  }
});

export default router;
