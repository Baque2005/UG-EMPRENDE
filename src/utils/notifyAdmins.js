import { supabase } from '../config/supabase.js';
import { createNotification } from './createNotification.js';

export async function notifyAdmins({ title, message, meta, createdAt }) {
  const now = createdAt || new Date().toISOString();

  const { data: admins, error: adminsError } = await supabase
    .from('profiles')
    .select('id')
    .eq('role', 'admin');

  if (adminsError) return { ok: false, error: adminsError.message };
  if (!Array.isArray(admins) || admins.length === 0) return { ok: true, notified: 0 };

  let notified = 0;
  for (const a of admins) {
    const adminId = a?.id;
    if (!adminId) continue;
    try {
      await createNotification({ userId: adminId, title, message, meta, createdAt: now });
      notified += 1;
    } catch {
      // best-effort
    }
  }

  return { ok: true, notified };
}
