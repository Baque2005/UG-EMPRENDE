import { supabase } from '../config/supabase.js';
import { sendEmail } from './sendEmail.js';
import { notificationTemplate } from './emailTemplates.js';
import { sendPushToUser } from './push.js';

// Create a notification row and optionally send an email if the user has email_notifications enabled
export async function createNotification({ userId, title, message, meta, createdAt }) {
  const now = createdAt || new Date().toISOString();

  try {
    // Insert notification row (best-effort)
    await supabase.from('notifications').insert([{
      user_id: userId,
      title,
      message,
      meta: meta && typeof meta === 'object' ? meta : undefined,
      read: false,
      created_at: now,
    }]);
  } catch (e) {
    // ignore insert errors (best-effort)
  }

  try {
    // Check user settings: if email notifications enabled, send email
    const { data: settings, error: settingsErr } = await supabase
      .from('user_settings')
      .select('email_notifications, push_notifications')
      .eq('user_id', userId)
      .maybeSingle();

    const suppressEmail = Boolean(meta && typeof meta === 'object' && meta.suppressEmail);

    const kind = String(meta && typeof meta === 'object' ? (meta.kind || '') : '').toLowerCase();
    const isChat = kind === 'chat';

    // Chat email independiente del email global del perfil.
    // - Si meta.chatEmailEnabled está en false/undefined => NO mandar correo de chat.
    // - Si está en true => mandar correo de chat (aunque email_notifications global sea false).
    const metaChatEmailEnabled = Boolean(meta && typeof meta === 'object' && meta.chatEmailEnabled);

    // Conservador: si no podemos leer settings, NO enviar correo por defecto.
    // Evita spam por errores transitorios o mala configuración.
    const emailNotifications = suppressEmail
      ? false
      : (isChat
        ? metaChatEmailEnabled
        : (settingsErr ? false : (settings?.email_notifications ?? true)));
    const pushNotifications = settingsErr ? false : (settings?.push_notifications ?? false);

    if (!emailNotifications && !pushNotifications) return { ok: true, emailed: false, pushed: false };

    // Get user email
    const { data: profile, error: profileErr } = await supabase
      .from('profiles')
      .select('email')
      .eq('id', userId)
      .maybeSingle();

    if (profileErr || !profile?.email) return { ok: true, emailed: false };

    // Send email (best-effort)
    const subject = title || 'Notificación';
    const text = message || '';
    const url = meta && meta.url ? meta.url : undefined;
    const ctaLabel = meta && meta.ctaLabel ? meta.ctaLabel : undefined;
    const html = notificationTemplate(subject, message || '', url, ctaLabel);

    const mailRes = await sendEmail({ to: profile.email, subject, text, html });

    // Send push notifications if enabled for user (best-effort)
    let pushRes = null;
    if (pushNotifications) {
      const payload = { title: subject, body: message || '', url: url || undefined };
      try {
        pushRes = await sendPushToUser(userId, payload);
      } catch (e) {
        pushRes = { ok: false, error: e };
      }
    }

    return { ok: mailRes.ok, emailed: Boolean(mailRes.ok), mailResult: mailRes, pushed: pushRes };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

export default createNotification;
