import { supabase } from '../config/supabase.js';

export async function notifyAdmins({
  title,
  message,
  meta,
  createdAt,
}) {
  const now = createdAt || new Date().toISOString();

  const { data: admins, error: adminsError } = await supabase
    .from('profiles')
    .select('id')
    .eq('role', 'admin');

  if (adminsError) return { ok: false, error: adminsError.message };
  if (!Array.isArray(admins) || admins.length === 0) return { ok: true, notified: 0 };

  const rows = admins
    .map((a) => a?.id)
    .filter(Boolean)
    .map((adminId) => ({
      user_id: adminId,
      title,
      message,
      meta: meta && typeof meta === 'object' ? meta : undefined,
      read: false,
      created_at: now,
    }));

  if (rows.length === 0) return { ok: true, notified: 0 };

  const { error } = await supabase.from('notifications').insert(rows);
  if (error) return { ok: false, error: error.message };

  return { ok: true, notified: rows.length };
}
