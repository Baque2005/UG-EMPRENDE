import webpush from 'web-push';
import { supabase } from '../config/supabase.js';

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.warn('VAPID keys not set. Generate them with `npx web-push generate-vapid-keys`.');
}

try {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} catch (e) {
  // ignore if not configured
}

export function getVapidPublicKey() {
  return VAPID_PUBLIC_KEY;
}

export async function sendPush(subscription, payload) {
  try {
    const res = await webpush.sendNotification(subscription, JSON.stringify(payload));
    return { ok: true, result: res };
  } catch (err) {
    return { ok: false, error: err };
  }
}

export async function sendPushToUser(userId, payload) {
  try {
    const { data, error } = await supabase.from('push_subscriptions').select('id, subscription').eq('user_id', userId);
    if (error) return { ok: false, error };
    const results = [];
    for (const row of data || []) {
      const sub = row.subscription;
      const r = await sendPush(sub, payload);
      // If subscription is gone/expired, remove it
      if (!r.ok && r.error && (r.error.statusCode === 410 || r.error.statusCode === 404)) {
        try {
          await supabase.from('push_subscriptions').delete().eq('id', row.id);
        } catch (e) {
          // ignore
        }
      }
      results.push(r);
    }
    return { ok: true, results };
  } catch (e) {
    return { ok: false, error: e };
  }
}

export default { getVapidPublicKey, sendPush, sendPushToUser };
