import { Router } from 'express';
import { z } from 'zod';
import { supabase, supabaseAuth } from '../config/supabase.js';
import { parseDataUrl, guessFileExtFromMime } from '../utils/dataUrl.js';
import { randomUUID } from 'crypto';
import { requireAuth } from '../middlewares/auth.js';
import { notifyAdmins } from '../utils/notifyAdmins.js';

const router = Router();

// Helper para subir data URLs a storage
async function uploadDataUrlToStorage({ bucket, folder, dataUrl }) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return null;

  const ext = guessFileExtFromMime(parsed.mimeType);
  const filePath = `${folder}/${Date.now()}_${randomUUID()}.${ext}`;

  const { error: uploadError } = await supabase.storage.from(bucket).upload(filePath, parsed.buffer, { contentType: parsed.mimeType });
  if (uploadError) throw uploadError;

  const { data } = supabase.storage.from(bucket).getPublicUrl(filePath);
  return data.publicUrl;
}

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
    // Permitimos registrar con role 'entrepreneur' sin enviar ahora los datos del negocio.
    // El negocio se creará después del login/confirmación usando el endpoint protegido `/api/business`.
    if (val.role !== 'entrepreneur') return;

    // Requerimos teléfono para emprendedores en el perfil inicial.
    if (!String(val.phone || '').trim()) {
      ctx.addIssue({ code: 'custom', message: 'El teléfono es obligatorio para emprendedores.', path: ['phone'] });
    }
    // Nota: no forzamos `business` aquí: se gestionará tras confirmar el correo y al iniciar sesión.
  });

router.post('/register', async (req, res, next) => {
  try {
    const body = registerSchema.parse(req.body);

    // Comprobación previa: si ya existe un profile con este email, devolver 409 antes de crear Auth user.
    try {
      const { data: existingByEmail, error: existingErr } = await supabase.from('profiles').select('id').eq('email', body.email).maybeSingle();
      if (existingErr) {
        // Si la consulta falla por permisos u otro motivo, no bloqueamos el flujo; sólo logueamos.
        console.warn('Error comprobando email en profiles antes de signUp:', existingErr?.message || existingErr);
      } else if (existingByEmail) {
        return res.status(409).json({ error: 'Este correo ya está registrado. Inicia sesión o usa otro correo.', code: 'user_already_registered' });
      }
    } catch (e) {
      console.warn('Error comprobando perfil por email antes de signUp:', e?.message || e);
    }

    // 1) Crear usuario en Supabase Auth (Supabase enviará el email de confirmación si está habilitado)

    const redirectTo = process.env.SUPABASE_EMAIL_REDIRECT;
    const signUpPayload = {
      email: body.email,
      password: body.password,
      ...(redirectTo ? { options: { emailRedirectTo: redirectTo } } : {}),
    };

    // Supabase puede responder 502/503/504 si el proyecto está "cold" o temporalmente saturado.
    // Hacemos 1 reintento corto para mejorar UX sin duplicar lógica.
    let { data: authData, error: authError } = await supabaseAuth.auth.signUp(signUpPayload);
    if (authError && [502, 503, 504].includes(Number(authError.status))) {
      await new Promise((r) => setTimeout(r, 900));
      ({ data: authData, error: authError } = await supabaseAuth.auth.signUp(signUpPayload));
    }

    // LOG TEMPORAL: imprimir resultado de signUp
    console.log('=== [REGISTER] Resultado signUp ===');
    console.log('authData:', JSON.stringify(authData));
    console.log('authError:', authError);
    console.log('===================================');

    if (authError) {
      const msg = String(authError.message || 'Error al registrar').toLowerCase();
      if (msg.includes('already registered') || msg.includes('already exists')) {
        return res.status(409).json({
          error: 'Este correo ya está registrado. Inicia sesión o usa otro correo.',
          code: 'user_already_registered',
        });
      }

      const status = Number(authError.status) || 400;
      if ([502, 503, 504].includes(status)) {
        return res.status(504).json({
          error:
            'Supabase (Auth) tardó demasiado en responder. Intenta nuevamente en unos segundos. Si persiste, revisa el estado del proyecto en Supabase.',
          code: 'supabase_auth_timeout',
        });
      }

      return res.status(400).json({ error: authError.message || 'Error al registrar' });
    }
    if (!authData?.user) return res.status(500).json({ error: 'No se pudo crear el usuario' });

    const userId = authData.user.id;
      // Crear o actualizar perfil con los datos proporcionados en el formulario.
      try {
        const profilePayload = {
          id: userId,
          name: body.name,
          email: body.email,
          phone: body.phone || '',
          faculty: body.faculty || '',
          role: body.role || 'customer',
        };

        // Upsert para no duplicar si ya existe
        const { data: profileData, error: profileError } = await supabase
          .from('profiles')
          .upsert([profilePayload], { onConflict: 'id' })
          .select()
          .maybeSingle();

        if (profileError) {
          console.warn('No se pudo crear/actualizar el profile tras registro:', profileError.message || profileError);
          // Si el fallo fue por clave única en email, eliminamos el usuario Auth recién creado para evitar orfandad.
          const msg = String(profileError.message || '').toLowerCase();
          if (msg.includes('duplicate') || msg.includes('profiles_email_unique') || msg.includes('unique constraint')) {
            try {
              await supabase.auth.admin.deleteUser(userId);
            } catch (delErr) {
              console.warn('Error eliminando usuario Auth tras conflicto de email:', delErr?.message || delErr);
            }
            return res.status(409).json({ error: 'Este correo ya está registrado. Inicia sesión o usa otro correo.', code: 'user_already_registered' });
          }
        }
        // Si el frontend incluyó datos del negocio en el registro, los guardamos temporalmente
        // en `user_metadata.pending_business` del usuario Auth para poder crearlo al primer login.
        if (body.business) {
          try {
            // Usamos el cliente admin para actualizar metadata (service role)
            await supabase.auth.admin.updateUserById(userId, {
              user_metadata: { pending_business: body.business },
            });
          } catch (metaErr) {
            console.warn('No se pudo guardar pending_business en user_metadata:', metaErr?.message || metaErr);
          }
        }
      } catch (e) {
        console.warn('Error al insertar profile tras signUp:', e?.message || e);
      }

        // ...existing code...

      // Devolvemos el id del usuario para referencia. El frontend redirige al login y el usuario
      // deberá confirmar el correo desde su bandeja para poder iniciar sesión.
      return res.status(201).json({ message: 'Usuario registrado. Revisa tu correo para confirmar.', user: { id: userId, email: body.email } });
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

    if (error) {
      const msg = String(error.message || '').toLowerCase();
      if (msg.includes('email not confirmed') || msg.includes('email_not_confirmed')) {
        return res.status(403).json({
          error:
            'Tu correo aún no está verificado. Revisa tu bandeja de entrada y también Spam/Promociones.\nSi no encuentras el correo, usa "Reenviar correo de confirmación" e inténtalo nuevamente en 1-2 minutos.',
          code: 'email_not_confirmed',
        });
      }

      return res.status(401).json({ error: error.message });
    }

    const token = data.session?.access_token;
    const user = data.user;

    // Comprobamos estado de confirmación del email usando el cliente admin
    try {
      const { data: adminResp, error: adminErr } = await supabase.auth.admin.getUserById(user.id);
      const adminUser = adminResp?.user || adminResp;
      const confirmed = !!(adminUser?.email_confirmed_at || adminUser?.confirmed_at || adminUser?.email_confirmed);
      if (!confirmed) {
        // No permitir login si el correo no está verificado
        return res.status(403).json({ error: 'El correo no está verificado. Revisa tu correo para activarlo.' });
      }
    } catch (e) {
      console.warn('No se pudo verificar estado de email en admin.getUserById:', e?.message || e);
      // En caso de error al consultar, no bloquear automáticamente; permitimos continuar.
    }

    // Puede existir el usuario en Auth pero no su fila en `profiles` (por fallos previos de RLS,
    // registros interrumpidos, etc). En ese caso, no rompemos el login: creamos el profile.
    // Además seleccionamos `pending_business` desde user_metadata más abajo (admin client).
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
      // Si el perfil indica que es emprendedor pero aún no tiene business_id, y existe
      // `pending_business` en user_metadata, intentamos crear el negocio automáticamente.
      try {
        const pending = adminUser?.user_metadata?.pending_business;
        if (ensuredProfile && ensuredProfile.role === 'entrepreneur' && !ensuredProfile.business_id && pending) {
          try {
            const bizPayload = {
              owner_id: user.id,
              name: pending.name,
              description: pending.description || '',
              category: pending.category,
              phone: pending.phone || ensuredProfile.phone || '',
              email: pending.email || user.email,
              instagram: pending.instagram || null,
              logo_url: null,
              banner_url: null,
            };

            // Subir logo/banner si vienen como data URLs
            try {
              if (pending.logo && typeof pending.logo === 'string' && pending.logo.startsWith('data:')) {
                bizPayload.logo_url = await uploadDataUrlToStorage({ bucket: 'business-assets', folder: 'logos', dataUrl: pending.logo });
              } else if (pending.logo) {
                bizPayload.logo_url = pending.logo;
              }
            } catch (uErr) {
              console.warn('Error subiendo logo desde pending_business:', uErr?.message || uErr);
            }

            try {
              if (pending.banner && typeof pending.banner === 'string' && pending.banner.startsWith('data:')) {
                bizPayload.banner_url = await uploadDataUrlToStorage({ bucket: 'business-assets', folder: 'banners', dataUrl: pending.banner });
              } else if (pending.banner) {
                bizPayload.banner_url = pending.banner;
              }
            } catch (uErr) {
              console.warn('Error subiendo banner desde pending_business:', uErr?.message || uErr);
            }

            const { data: bizData, error: bizError } = await supabase.from('businesses').insert([bizPayload]).select().single();
            if (!bizError && bizData?.id) {
              // vincular al profile
              await supabase.from('profiles').update({ business_id: bizData.id }).eq('id', user.id);
              ensuredProfile.business_id = bizData.id;

              // Limpiar pending_business de user_metadata (conservar otras claves si existen)
              try {
                const meta = adminUser?.user_metadata || {};
                const nextMeta = { ...meta };
                delete nextMeta.pending_business;
                await supabase.auth.admin.updateUserById(user.id, { user_metadata: nextMeta });
              } catch (cErr) {
                console.warn('No se pudo limpiar pending_business en user_metadata:', cErr?.message || cErr);
              }

              // Notificar admins
              try {
                await notifyAdmins({
                  title: 'Nuevo negocio creado (post-confirmación)',
                  message: `Se creó el negocio "${bizData.name}" por ${user.email} al iniciar sesión.`,
                  meta: { kind: 'business', action: 'created', businessId: bizData.id, ownerUserId: user.id },
                });
              } catch (nErr) {
                // ignore
              }
            }
          } catch (e) {
            console.warn('Error creando negocio desde pending_business en login:', e?.message || e);
          }
        }
      } catch (e) {
        // ignore
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

// Enviar enlace de recuperación de contraseña (o magic link si reset no está disponible)
const passwordResetSchema = z.object({ email: z.string().email() });
router.post('/send-password-reset', async (req, res, next) => {
  try {
    const { email } = passwordResetSchema.parse(req.body);

    const redirectTo = process.env.SUPABASE_EMAIL_REDIRECT_PASSWORD || process.env.SUPABASE_EMAIL_REDIRECT;
    const options = redirectTo ? { redirectTo } : undefined;

    // Intentar usar la API de resetPasswordForEmail si está disponible
    try {
      if (typeof supabaseAuth.auth.resetPasswordForEmail === 'function') {
        const { data, error } = await supabaseAuth.auth.resetPasswordForEmail(email, options);
        if (error) return res.status(400).json({ error: error.message });
        return res.json({ ok: true, message: 'Se ha enviado el correo de recuperación si el email existe.' });
      }
    } catch (e) {
      // continúa al fallback
      console.warn('resetPasswordForEmail no disponible o falló, usando fallback:', e?.message || e);
    }

    // Fallback: enviar magic link (signInWithOtp) como alternativa
    const { data, error } = await supabaseAuth.auth.signInWithOtp({ email }, options);
    if (error) return res.status(400).json({ error: error.message });

    return res.json({ ok: true, message: 'Se ha enviado un link de acceso/recuperación si el email existe.' });
  } catch (err) {
    return next(err);
  }
});

// Reset de contraseña: recibe access_token y nueva contraseña, valida token y actualiza contraseña con service role
const resetPasswordSchema = z.object({ access_token: z.string().min(1), password: z.string().min(6) });
router.post('/reset-password', async (req, res, next) => {
  try {
    const { access_token, password } = resetPasswordSchema.parse(req.body);

    // Validar token y obtener usuario
    const { data: userData, error: userErr } = await supabaseAuth.auth.getUser(access_token);
    if (userErr) return res.status(400).json({ error: userErr.message });

    const user = userData?.user || userData;
    if (!user || !user.id) return res.status(400).json({ error: 'Token inválido' });

    // Actualizar contraseña usando service role (admin)
    const { error: updErr } = await supabase.auth.admin.updateUserById(user.id, { password });
    if (updErr) return res.status(400).json({ error: updErr.message });

    return res.json({ ok: true, message: 'Contraseña actualizada correctamente.' });
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
      const bizPayload = {
        owner_id: body.userId,
        name: body.business.name,
        description: body.business.description,
        category: body.business.category,
        phone: body.business.phone || body.phone,
        email: body.business.email || body.email,
        instagram: body.business.instagram,
        logo_url: null,
        banner_url: null,
      };

      // Subir logo/banner si vienen como data URLs
      try {
        if (body.business.logo && typeof body.business.logo === 'string' && body.business.logo.startsWith('data:')) {
          bizPayload.logo_url = await uploadDataUrlToStorage({ bucket: 'business-assets', folder: 'logos', dataUrl: body.business.logo });
        } else if (body.business.logo) {
          bizPayload.logo_url = body.business.logo;
        }
      } catch (uErr) {
        console.warn('Error subiendo logo en complete-registration:', uErr?.message || uErr);
      }

      try {
        if (body.business.banner && typeof body.business.banner === 'string' && body.business.banner.startsWith('data:')) {
          bizPayload.banner_url = await uploadDataUrlToStorage({ bucket: 'business-assets', folder: 'banners', dataUrl: body.business.banner });
        } else if (body.business.banner) {
          bizPayload.banner_url = body.business.banner;
        }
      } catch (uErr) {
        console.warn('Error subiendo banner en complete-registration:', uErr?.message || uErr);
      }

      const { data: bizData, error: bizError } = await supabase.from('businesses').insert([bizPayload]).select().single();

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
    // Limpieza best-effort de datos ligados al usuario.
    // Eliminamos datos en varias tablas relacionadas. No tocamos productos/negocios por seguridad.
    try {
      await Promise.allSettled([
        supabase.from('notifications').delete().eq('user_id', req.user.id),
        supabase.from('payment_methods').delete().eq('user_id', req.user.id),
        supabase.from('delivery_addresses').delete().eq('user_id', req.user.id),
        supabase.from('user_settings').delete().eq('user_id', req.user.id),
        supabase.from('favorites').delete().eq('user_id', req.user.id),
        supabase.from('push_subscriptions').delete().eq('user_id', req.user.id),
        supabase.from('notifications').delete().eq('user_id', req.user.id),
        supabase.from('reports').delete().or(`reporter_id.eq.${req.user.id},owner_user_id.eq.${req.user.id}`),
      ]);
    } catch (e) {
      // ignore best-effort errors
    }

    // Orders and order_items: eliminar primero items asociados a las órdenes del usuario
    try {
      const { data: userOrders, error: ordersErr } = await supabase.from('orders').select('id').eq('customer_id', req.user.id);
      if (!ordersErr && Array.isArray(userOrders) && userOrders.length > 0) {
        const ids = userOrders.map((o) => o.id);
        await supabase.from('order_items').delete().in('order_id', ids);
        await supabase.from('orders').delete().in('id', ids);
      }
    } catch (e) {
      // ignore
    }

    // Borrar perfil del usuario (fila en profiles)
    try {
      await supabase.from('profiles').delete().eq('id', req.user.id);
    } catch (e) {
      // ignore
    }

    // Finalmente, eliminar el usuario de Auth (Supabase)
    const { error } = await supabase.auth.admin.deleteUser(req.user.id);
    if (error) return res.status(400).json({ error: error.message });

    return res.json({ message: 'Cuenta eliminada' });
  } catch (err) {
    return next(err);
  }
});

export default router;

// Endpoint: crear negocio desde `user_metadata.pending_business` para usuarios autenticados
// Útil si el usuario completó el formulario en el registro y los datos quedaron en metadata.
router.post('/create-pending-business', requireAuth, async (req, res, next) => {
  try {
    // Obtener usuario admin para leer user_metadata
    const { data: adminResp, error: adminErr } = await supabase.auth.admin.getUserById(req.user.id);
    const adminUser = adminResp?.user || adminResp;
    if (adminErr) return res.status(400).json({ error: adminErr.message || 'No se pudo obtener usuario admin' });

    const pending = adminUser?.user_metadata?.pending_business;
    if (!pending) return res.status(404).json({ error: 'No hay negocio pendiente para crear' });

    // Verificar perfil
    const { data: profile, error: profileErr } = await supabase.from('profiles').select('role, business_id').eq('id', req.user.id).maybeSingle();
    if (profileErr) return res.status(400).json({ error: profileErr.message });
    if (!profile) return res.status(404).json({ error: 'Perfil no encontrado' });
    if (profile.business_id) return res.status(409).json({ error: 'Tu cuenta ya tiene un negocio asociado' });

    // Construir payload y subir assets si aplican
    const bizPayload = {
      owner_id: req.user.id,
      name: pending.name,
      description: pending.description || '',
      category: pending.category,
      phone: pending.phone || '',
      email: pending.email || req.user.email,
      instagram: pending.instagram || null,
      logo_url: null,
      banner_url: null,
    };

    try {
      if (pending.logo && typeof pending.logo === 'string' && pending.logo.startsWith('data:')) {
        bizPayload.logo_url = await uploadDataUrlToStorage({ bucket: 'business-assets', folder: 'logos', dataUrl: pending.logo });
      } else if (pending.logo) {
        bizPayload.logo_url = pending.logo;
      }
    } catch (uErr) {
      console.warn('Error subiendo logo en create-pending-business:', uErr?.message || uErr);
    }

    try {
      if (pending.banner && typeof pending.banner === 'string' && pending.banner.startsWith('data:')) {
        bizPayload.banner_url = await uploadDataUrlToStorage({ bucket: 'business-assets', folder: 'banners', dataUrl: pending.banner });
      } else if (pending.banner) {
        bizPayload.banner_url = pending.banner;
      }
    } catch (uErr) {
      console.warn('Error subiendo banner en create-pending-business:', uErr?.message || uErr);
    }

    const { data: bizData, error: bizError } = await supabase.from('businesses').insert([bizPayload]).select().single();
    if (bizError) return res.status(400).json({ error: bizError.message });

    // Vincular al profile
    await supabase.from('profiles').update({ business_id: bizData.id, role: 'entrepreneur' }).eq('id', req.user.id);

    // Limpiar pending_business
    try {
      const meta = adminUser?.user_metadata || {};
      const nextMeta = { ...meta };
      delete nextMeta.pending_business;
      await supabase.auth.admin.updateUserById(req.user.id, { user_metadata: nextMeta });
    } catch (cErr) {
      console.warn('No se pudo limpiar pending_business en user_metadata (create-pending-business):', cErr?.message || cErr);
    }

    try {
      await notifyAdmins({
        title: 'Negocio creado desde metadata',
        message: `Se creó el negocio "${bizData.name}" por ${req.user.email} mediante create-pending-business.`,
        meta: { kind: 'business', action: 'created', businessId: bizData.id, ownerUserId: req.user.id },
      });
    } catch {
      // ignore
    }

    return res.status(201).json({ business: bizData });
  } catch (err) {
    return next(err);
  }
});
