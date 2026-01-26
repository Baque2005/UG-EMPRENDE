import { supabase } from './config/supabase.js';

export const getMessages = async (orderId) => {
  if (!orderId) return [];
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('order_id', orderId)
    .order('created_at', { ascending: true });
  if (error) {
    // eslint-disable-next-line no-console
    console.error('Supabase getMessages error', error);
    return [];
  }
  return data || [];
};

export const addMessage = async (orderId, message) => {
  if (!orderId || !message || !message.text) return null;
  const payload = {
    order_id: orderId,
    sender_id: message.senderId || null,
    sender_name: message.senderName || 'Anon',
    text: message.text,
  };
  const { data, error } = await supabase.from('messages').insert(payload).select().single();
  if (error) {
    // eslint-disable-next-line no-console
    console.error('Supabase addMessage error', error);
    return null;
  }
  return data;
};

export default { getMessages, addMessage };
