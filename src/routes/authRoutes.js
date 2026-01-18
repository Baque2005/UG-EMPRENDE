import { Router } from 'express';
import { z } from 'zod';
import { supabase, supabaseAuth } from '../config/supabase.js';
import { requireAuth } from '../middlewares/auth.js';
import { notifyAdmins } from '../utils/notifyAdmins.js';

const router = Router();

const registerSchema = z
  .object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6),
  role: z.enum(['customer', 'entrepreneur', 'admin']).default('customer'),
  phone: z.string().optional().default(''),
  faculty: z.string().optional().default(''),
  business: z
    .object({
      name: z.string().min(1),
      description: z.string().optional().default(''),
      category: z.string().min(1),
      instagram: z.string().optional().default(''),
      phone: z.string().optional().default(''),
      email: z.string().email().optional(),
      logo: z.string().optional(),
      banner: z.string().optional(),
    })
    .optional(),
  })
  .superRefine((val, ctx) => {
    if (val.role !== 'entrepreneur') return;

    if (!String(val.phone || '').trim()) {
      ctx.addIssue({ code: 'custom', message: 'El teléfono es obligatorio para emprendedores.', path: ['phone'] });
    }

    if (!val.business) {
      ctx.addIssue({ code: 'custom', message: 'Falta la información del negocio.', path: ['business'] });
      return;
    }

    if (!String(val.business.description || '').trim()) {
      ctx.addIssue({
        code: 'custom',
        message: 'La descripción del negocio es obligatoria para emprendedores.',
        path: ['business', 'description'],
      });
    }
  });

router.post('/register', async (req, res, next) => {
  try {
    const body = registerSchema.parse(req.body);

    // 1) Crear usuario en Supabase Auth (Supabase enviará el email de confirmación si está habilitado)
    const { data: authData, error: authError } = await supabaseAuth.auth.signUp(
      {
        email: body.email,
        password: body.password,
      },
      // Opcional: redirigir después de la confirmación. Definir SUPABASE_EMAIL_REDIRECT en .env
      process.env.SUPABASE_EMAIL_REDIRECT ? { emailRedirectTo: process.env.SUPABASE_EMAIL_REDIRECT } : undefined,
    );

    if (authError) {
      const msg = String(authError.message || 'Error al registrar').toLowerCase();
      if (msg.includes('already registered') || msg.includes('already exists')) {
        return res.status(409).json({
          error: 'Este correo ya está registrado. Inicia sesión o usa otro correo.',
          code: 'user_already_registered',
        });
      }
      return res.status(400).json({ error: authError.message });
    }
    if (!authData?.user) return res.status(500).json({ error: 'No se pudo crear el usuario' });

    const userId = authData.user.id;

    // 2) Crear perfil
    const { error: profileError } = await supabase.from('profiles').insert([
      {
        id: userId,
        name: body.name,
        email: body.email,
        phone: body.phone,
        faculty: body.faculty,
        role: body.role,
      },
    ]);

    if (profileError) return res.status(400).json({ error: profileError.message });

    // Notificar admins: nuevo usuario
    await notifyAdmins({
      title: 'Nuevo usuario registrado',
      message: `${body.name} (${body.email}) se registró como ${body.role}.`,
      meta: { kind: 'user', action: 'created', userId },
    });

    // 3) Si es emprendedor y mandó negocio, se crea negocio y se vincula al perfil
    if (body.role === 'entrepreneur' && body.business) {
      const { data: bizData, error: bizError } = await supabase
        .from('businesses')
        .insert([
          {
            owner_id: userId,
            name: body.business.name,
            description: body.business.description,
            category: body.business.category,
            phone: body.business.phone || body.phone,
            email: body.business.email || body.email,
            instagram: body.business.instagram,
            logo_url: body.business.logo || null,
            banner_url: body.business.banner || null,
          },
        ])
        .select()
        .single();

      if (bizError) return res.status(400).json({ error: bizError.message });

      const { error: linkError } = await supabase
        .from('profiles')
        .update({ business_id: bizData.id })
        .eq('id', userId);

      if (linkError) return res.status(400).json({ error: linkError.message });

      // Notificar admins: nuevo negocio creado en el registro
      await notifyAdmins({
        title: 'Nuevo negocio registrado',
        message: `Se creó el negocio "${body.business.name}" por ${body.email}.`,
        meta: { kind: 'business', action: 'created', businessId: bizData.id, ownerUserId: userId },
      });
    }

    // Puede que no haya sesión si Supabase requiere confirmación por email
    const token = authData.session?.access_token || null;

    return res.status(201).json({
      message: 'Usuario registrado',
      token,
      user: { id: userId, email: body.email },
    });
  } catch (err) {
    return next(err);
  }
});

// Nota: la verificación de email se maneja mediante Supabase (confirmación por link).
// Los endpoints de verificación por código y reenvío se han eliminado para usar la funcionalidad nativa de Supabase.

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post('/login', async (req, res, next) => {
  try {
    const body = loginSchema.parse(req.body);

    const { data, error } = await supabaseAuth.auth.signInWithPassword({
      email: body.email,
      password: body.password,
    });

    if (error) return res.status(401).json({ error: error.message });

    const token = data.session?.access_token;
    const user = data.user;

    // Puede existir el usuario en Auth pero no su fila en `profiles` (por fallos previos de RLS,
    // registros interrumpidos, etc). En ese caso, no rompemos el login: creamos el profile.
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, name, role, business_id, phone, faculty')
      .eq('id', user.id)
      .maybeSingle();

    if (profileError) return res.status(400).json({ error: profileError.message });

    let ensuredProfile = profile;
    if (!ensuredProfile) {
      const fallbackName = (user.email || '').split('@')[0] || 'Usuario';

      const { data: created, error: createError } = await supabase
        .from('profiles')
        .insert([
          {
            id: user.id,
            name: fallbackName,
            email: user.email || body.email,
            phone: '',
            faculty: '',
            role: 'customer',
          },
        ])
        .select('id, name, role, business_id, phone, faculty')
        .single();

      if (createError) return res.status(400).json({ error: createError.message });
      ensuredProfile = created;
    }

    // Sincronizar campo `email_verified` en `profiles` según el estado en Supabase Auth
    try {
      // Usamos el cliente admin (service role) `supabase` para consultar el usuario
      const { data: adminResp, error: adminErr } = await supabase.auth.admin.getUserById(user.id);
      const adminUser = adminResp?.user || adminResp;
      const confirmed = !!(adminUser?.email_confirmed_at || adminUser?.confirmed_at || adminUser?.email_confirmed);
      if (confirmed && !ensuredProfile.email_verified) {
        const { error: updVerifiedErr } = await supabase.from('profiles').update({ email_verified: true }).eq('id', user.id);
        if (!updVerifiedErr) ensuredProfile.email_verified = true;
      }
    } catch (e) {
      console.warn('No se pudo sincronizar email_verified:', e?.message || e);
    }

    return res.json({
      token,
      user: { id: user.id, email: user.email },
      profile: {
        id: ensuredProfile.id,
        name: ensuredProfile.name,
        role: ensuredProfile.role,
        businessId: ensuredProfile.business_id,
        phone: ensuredProfile.phone,
        faculty: ensuredProfile.faculty,
      },
    });
  } catch (err) {
    return next(err);
  }
});

// Reenviar link de confirmación (magic link) usando Supabase
const resendConfirmSchema = z.object({ email: z.string().email() });
router.post('/resend-confirmation', async (req, res, next) => {
  try {
    const { email } = resendConfirmSchema.parse(req.body);

    // Usamos el cliente de auth (anon o service role según configuración)
    const options = process.env.SUPABASE_EMAIL_REDIRECT ? { redirectTo: process.env.SUPABASE_EMAIL_REDIRECT } : undefined;
    const { data, error } = await supabaseAuth.auth.signInWithOtp({ email }, options);

    // No revelamos si el email existe o no por seguridad
    if (error) {
      // Algunos errores pueden indicar falta de configuración; los devolvemos para debugging
      return res.status(400).json({ error: error.message });
    }

    return res.json({ ok: true, message: 'Se ha enviado un link de acceso/confirmación si el email existe.' });
  } catch (err) {
    return next(err);
  }
});

// Enviar link de verificación durante el registro (redirige de vuelta a la página de registro)
const sendVerifySchema = z.object({ email: z.string().email() });
router.post('/send-verification', async (req, res, next) => {
  try {
    const { email } = sendVerifySchema.parse(req.body);

    const redirectTo = process.env.SUPABASE_EMAIL_REDIRECT_REGISTER || process.env.SUPABASE_EMAIL_REDIRECT;
    const options = redirectTo ? { redirectTo } : undefined;

    const { data, error } = await supabaseAuth.auth.signInWithOtp({ email }, options);

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    return res.json({ ok: true, message: 'Se ha enviado el enlace de verificación si el email existe.' });
  } catch (err) {
    return next(err);
  }
});

// Verificar token (usado al regresar desde el link de Supabase)
const verifyTokenSchema = z.object({ access_token: z.string().min(1) });
router.post('/verify-token', async (req, res, next) => {
  try {
    const { access_token } = verifyTokenSchema.parse(req.body);

    // Usamos el cliente de auth para obtener el usuario asociado al token
    const { data, error } = await supabaseAuth.auth.getUser(access_token);
    if (error) return res.status(400).json({ error: error.message });

    const user = data?.user || data;
    const confirmed = !!(user?.email_confirmed_at || user?.confirmed_at || user?.email_confirmed);

    return res.json({ ok: true, id: user?.id || null, email: user?.email || null, confirmed });
  } catch (err) {
    return next(err);
  }
});

// Completar registro para usuarios ya creados/confirmados por magic link
const completeRegistrationSchema = z.object({
  userId: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6),
  role: z.enum(['customer', 'entrepreneur', 'admin']).default('customer'),
  phone: z.string().optional().default(''),
  faculty: z.string().optional().default(''),
  business: z
    .object({
      name: z.string().min(1),
      description: z.string().optional().default(''),
      category: z.string().min(1),
      instagram: z.string().optional().default(''),
      phone: z.string().optional().default(''),
      email: z.string().email().optional(),
      logo: z.string().optional(),
      banner: z.string().optional(),
    })
    .optional(),
});

router.post('/complete-registration', async (req, res, next) => {
  try {
    const body = completeRegistrationSchema.parse(req.body);

    // 1) Establecer contraseña para el usuario en Auth (admin)
    const { error: updateErr } = await supabase.auth.admin.updateUserById(body.userId, {
      password: body.password,
    });
    if (updateErr) return res.status(400).json({ error: updateErr.message });

    // 2) Crear o actualizar perfil con el mismo id
    const profilePayload = {
      id: body.userId,
      name: body.name,
      email: body.email,
      phone: body.phone,
      faculty: body.faculty,
      role: body.role,
    };

    const { data: existing, error: existingErr } = await supabase.from('profiles').select('id').eq('id', body.userId).maybeSingle();
    if (existingErr) return res.status(400).json({ error: existingErr.message });

    if (existing) {
      const { error: updErr } = await supabase.from('profiles').update(profilePayload).eq('id', body.userId);
      if (updErr) return res.status(400).json({ error: updErr.message });
    } else {
      const { error: insErr } = await supabase.from('profiles').insert([profilePayload]);
      if (insErr) return res.status(400).json({ error: insErr.message });
    }

    // 3) Si es emprendedor y mandó negocio, crear negocio y vincular
    if (body.role === 'entrepreneur' && body.business) {
      const { data: bizData, error: bizError } = await supabase
        .from('businesses')
        .insert([
          {
            owner_id: body.userId,
            name: body.business.name,
            description: body.business.description,
            category: body.business.category,
            phone: body.business.phone || body.phone,
            email: body.business.email || body.email,
            instagram: body.business.instagram,
            logo_url: body.business.logo || null,
            banner_url: body.business.banner || null,
          },
        ])
        .select()
        .single();

      if (bizError) return res.status(400).json({ error: bizError.message });

      const { error: linkError } = await supabase.from('profiles').update({ business_id: bizData.id }).eq('id', body.userId);
      if (linkError) return res.status(400).json({ error: linkError.message });

      await notifyAdmins({
        title: 'Nuevo negocio registrado (completado)',
        message: `Se creó el negocio "${body.business.name}" por ${body.email}.`,
        meta: { kind: 'business', action: 'created', businessId: bizData.id, ownerUserId: body.userId },
      });
    }

    // 4) Iniciar sesión para devolver token al frontend
    const { data: signData, error: signErr } = await supabaseAuth.auth.signInWithPassword({
      email: body.email,
      password: body.password,
    });
    if (signErr) return res.status(400).json({ error: signErr.message });

    const token = signData.session?.access_token || null;

    await notifyAdmins({
      title: 'Usuario completó registro',
      message: `${body.name} (${body.email}) completó el registro.`,
      meta: { kind: 'user', action: 'completed_registration', userId: body.userId },
    });

    return res.status(201).json({ message: 'Registro completado', token, user: { id: body.userId, email: body.email } });
  } catch (err) {
    return next(err);
  }
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    // Usamos select('*') para tolerar columnas nuevas (p.ej. address, birth_date)
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', req.user.id)
      .single();

    if (error) return res.status(400).json({ error: error.message });

    return res.json({
      user: { id: req.user.id, email: req.user.email },
      profile: {
        id: profile.id,
        name: profile.name,
        email: profile.email,
        role: profile.role,
        businessId: profile.business_id,
        phone: profile.phone,
        faculty: profile.faculty,
        address: profile.address,
        birthDate: profile.birth_date,
        createdAt: profile.created_at,
      },
    });
  } catch (err) {
    return next(err);
  }
});

const updateMeSchema = z
  .object({
    name: z.string().min(1).optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    faculty: z.string().optional(),
    address: z.string().optional(),
    birthDate: z.string().optional(),
  })
  .strict();

router.patch('/me', requireAuth, async (req, res, next) => {
  try {
    const body = updateMeSchema.parse(req.body);
    if (Object.keys(body).length === 0) {
      return res.status(400).json({ error: 'No hay datos para actualizar' });
    }

    // Si cambia email, actualizamos también Supabase Auth
    if (body.email) {
      const { error: authErr } = await supabase.auth.admin.updateUserById(req.user.id, {
        email: body.email,
      });
      if (authErr) return res.status(400).json({ error: authErr.message });
    }

    const patchBase = {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.email !== undefined ? { email: body.email } : {}),
      ...(body.phone !== undefined ? { phone: body.phone } : {}),
      ...(body.faculty !== undefined ? { faculty: body.faculty } : {}),
      ...(body.address !== undefined ? { address: body.address } : {}),
      ...(body.birthDate !== undefined ? { birth_date: body.birthDate } : {}),
    };

    // Intento 1: con todos los campos (incluyendo posibles columnas nuevas)
    let { data: profile, error } = await supabase
      .from('profiles')
      .update(patchBase)
      .eq('id', req.user.id)
      .select('*')
      .single();

    // Si la DB no tiene columnas nuevas, reintentamos sin ellas
    if (error) {
      const msg = String(error.message || '').toLowerCase();
      const hadOptional = 'address' in patchBase || 'birth_date' in patchBase;
      if (hadOptional && (msg.includes('column') || msg.includes('birth_date') || msg.includes('address'))) {
        const safePatch = { ...patchBase };
        delete safePatch.address;
        delete safePatch.birth_date;
        ({ data: profile, error } = await supabase
          .from('profiles')
          .update(safePatch)
          .eq('id', req.user.id)
          .select('*')
          .single());
      }
    }

    if (error) return res.status(400).json({ error: error.message });

    return res.json({
      profile: {
        id: profile.id,
        name: profile.name,
        email: profile.email,
        role: profile.role,
        businessId: profile.business_id,
        phone: profile.phone,
        faculty: profile.faculty,
        address: profile.address,
        birthDate: profile.birth_date,
        createdAt: profile.created_at,
      },
    });
  } catch (err) {
    return next(err);
  }
});

router.delete('/me', requireAuth, async (req, res, next) => {
  try {
    // Limpieza best-effort de datos ligados al usuario (no tocamos negocios/productos)
    await Promise.allSettled([
      supabase.from('notifications').delete().eq('user_id', req.user.id),
      supabase.from('payment_methods').delete().eq('user_id', req.user.id),
      supabase.from('delivery_addresses').delete().eq('user_id', req.user.id),
      supabase.from('user_settings').delete().eq('user_id', req.user.id),
    ]);

    const { error } = await supabase.auth.admin.deleteUser(req.user.id);
    if (error) return res.status(400).json({ error: error.message });

    return res.json({ message: 'Cuenta eliminada' });
  } catch (err) {
    return next(err);
  }
});

export default router;
