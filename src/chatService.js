import { supabase } from './config/supabase.js';
import { parseDataUrl, guessFileExtFromMime } from './utils/dataUrl.js';
import { randomUUID } from 'crypto';

export const makeConversationId = (businessId, customerId) => {
  if (!businessId || !customerId) return null;
  return `conv:${businessId}:${customerId}`;
};

export const parseConversationId = (conversationId) => {
  if (typeof conversationId !== 'string') return null;
  if (!conversationId.startsWith('conv:')) return null;
  const parts = conversationId.split(':');
  if (parts.length < 3) return null;
  const businessId = parts[1] || null;
  const customerId = parts.slice(2).join(':') || null;
  if (!businessId || !customerId) return null;
  return { businessId, customerId };
};

// chatId puede ser un conversationId (conv:...) o un orderId.
export const resolveConversationMeta = async (chatId) => {
  if (!chatId) return { chatId: null, conversationId: null, businessId: null, customerId: null, orderId: null };

  const parsed = parseConversationId(chatId);
  if (parsed) {
    // Resolver owner_id del negocio (best-effort)
    let ownerUserId = null;
    try {
      const { data: biz } = await supabase
        .from('businesses')
        .select('owner_id')
        .eq('id', parsed.businessId)
        .maybeSingle();
      ownerUserId = biz?.owner_id || null;
    } catch {
      ownerUserId = null;
    }

    return {
      chatId,
      conversationId: chatId,
      businessId: parsed.businessId,
      customerId: parsed.customerId,
      businessOwnerUserId: ownerUserId,
      orderId: null,
    };
  }

  // Fallback: interpretar chatId como orderId y derivar la conversación
  try {
    const { data: order } = await supabase
      .from('orders')
      .select('id, business_id, customer_id')
      .eq('id', chatId)
      .single();

    const businessId = order?.business_id || null;
    const customerId = order?.customer_id || null;
    const conversationId = makeConversationId(businessId, customerId);

    let ownerUserId = null;
    try {
      if (businessId) {
        const { data: biz } = await supabase
          .from('businesses')
          .select('owner_id')
          .eq('id', businessId)
          .maybeSingle();
        ownerUserId = biz?.owner_id || null;
      }
    } catch {
      ownerUserId = null;
    }

    return {
      chatId,
      conversationId: conversationId || chatId,
      businessId,
      customerId,
      businessOwnerUserId: ownerUserId,
      orderId: order?.id || null,
    };
  } catch {
    // Si no existe la orden, mantenemos chatId tal cual
    return { chatId, conversationId: chatId, businessId: null, customerId: null, businessOwnerUserId: null, orderId: null };
  }
};

export const getMessages = async (chatId, viewerId = null) => {
  if (!chatId) return [];

  const meta = await resolveConversationMeta(chatId);
  const convoId = meta.conversationId;
  if (!convoId) return [];

  let query = supabase.from('messages').select('*').order('created_at', { ascending: true });
  // Compat: mostrar mensajes antiguos guardados por orderId (si difiere del conversationId)
  if (meta.orderId && meta.orderId !== convoId) {
    query = query.or(`order_id.eq.${meta.orderId},order_id.eq.${convoId}`);
  } else {
    query = query.eq('order_id', convoId);
  }

  const { data, error } = await query;
  if (error) {
    // eslint-disable-next-line no-console
    console.error('Supabase getMessages error', error);
    return [];
  }
  const list = data || [];
  if (!viewerId) return list;

  // Filtrar mensajes de usuarios bloqueados por el viewer
  try {
    const { data: blocks } = await supabase
      .from('user_blocks')
      .select('blocked_id')
      .eq('blocker_id', viewerId);
    const blockedIds = Array.isArray(blocks) ? blocks.map((b) => b.blocked_id) : [];
    return list.filter((m) => !blockedIds.includes(m.sender_id));
  } catch (e) {
    return list;
  }
};

export const getLastMessage = async (chatId, viewerId = null) => {
  if (!chatId) return null;

  const meta = await resolveConversationMeta(chatId);
  const convoId = meta.conversationId;
  if (!convoId) return null;

  let blockedIds = [];
  if (viewerId) {
    try {
      const { data: blocks } = await supabase
        .from('user_blocks')
        .select('blocked_id')
        .eq('blocker_id', viewerId);
      blockedIds = Array.isArray(blocks) ? blocks.map((b) => String(b.blocked_id)) : [];
    } catch {
      blockedIds = [];
    }
  }

  let query = supabase
    .from('messages')
    .select('*')
    .order('created_at', { ascending: false })
    // Best-effort: limitar para no traer historial completo
    .limit(30);

  // Compat: mostrar mensajes antiguos guardados por orderId (si difiere del conversationId)
  if (meta.orderId && meta.orderId !== convoId) {
    query = query.or(`order_id.eq.${meta.orderId},order_id.eq.${convoId}`);
  } else {
    query = query.eq('order_id', convoId);
  }

  const { data, error } = await query;
  if (error) {
    // eslint-disable-next-line no-console
    console.error('Supabase getLastMessage error', error);
    return null;
  }

  const list = Array.isArray(data) ? data : [];
  if (!viewerId || blockedIds.length === 0) return list[0] || null;

  // Tomar el último mensaje no bloqueado (best-effort dentro del límite)
  const visible = list.find((m) => !blockedIds.includes(String(m?.sender_id || '')));
  return visible || null;
};

export const addMessage = async (chatId, message) => {
  if (!chatId || !message || !message.text) return null;

  const meta = await resolveConversationMeta(chatId);
  const convoId = meta.conversationId || chatId;

  const payload = {
    // Importante: usamos order_id como "thread id" para evitar crear una nueva tabla/columna.
    // Esto permite que haya 1 solo chat por (business_id, customer_id), aunque existan múltiples órdenes.
    order_id: convoId,
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

export const addImageMessage = async (chatId, message) => {
  const dataUrl = message?.dataUrl || message?.imageDataUrl || null;
  if (!chatId || !dataUrl) return null;

  const parsed = parseDataUrl(String(dataUrl));
  if (!parsed?.buffer || !parsed?.mimeType) {
    const err = new Error('Invalid image');
    err.status = 400;
    throw err;
  }

  if (!String(parsed.mimeType).startsWith('image/')) {
    const err = new Error('Not an image');
    err.status = 400;
    throw err;
  }

  // Límite razonable (best-effort) para evitar payloads gigantes
  const maxBytes = 3 * 1024 * 1024;
  if (parsed.buffer.length > maxBytes) {
    const err = new Error('Image too large');
    err.status = 413;
    throw err;
  }

  const meta = await resolveConversationMeta(chatId);
  const convoId = meta.conversationId || chatId;

  const bucket = process.env.SUPABASE_CHAT_MEDIA_BUCKET || process.env.CHAT_MEDIA_BUCKET || 'chat-media';
  const ext = guessFileExtFromMime(parsed.mimeType);

  const safeConvo = String(convoId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const fileName = `${Date.now()}_${randomUUID()}.${ext}`;
  const objectPath = `chat/${safeConvo}/${fileName}`;

  const { error: upErr } = await supabase
    .storage
    .from(bucket)
    .upload(objectPath, parsed.buffer, {
      contentType: parsed.mimeType,
      upsert: false,
    });

  if (upErr) {
    // eslint-disable-next-line no-console
    console.error('Supabase storage upload error', upErr);
    const err = new Error('Upload failed');
    err.status = 500;
    throw err;
  }

  const { data: pub } = supabase.storage.from(bucket).getPublicUrl(objectPath);
  const publicUrl = pub?.publicUrl || null;
  if (!publicUrl) {
    const err = new Error('No public url');
    err.status = 500;
    throw err;
  }

  const caption = String(message?.caption || '').trim();
  const text = `__img__:${publicUrl}${caption ? `\n${caption}` : ''}`;

  return addMessage(convoId, {
    text,
    senderId: message?.senderId || null,
    senderName: message?.senderName || 'Anon',
  });
};

export default { getMessages, addMessage, addImageMessage };
