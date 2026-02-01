import express from 'express';
import { getMessages, addMessage, addImageMessage, getLastMessage } from '../chatService.js';
import { requireAuth } from '../middlewares/auth.js';
import { supabase } from '../config/supabase.js';
import { resolveConversationMeta } from '../chatService.js';

const router = express.Router();

async function ensureChatAccess(req, chatId) {
  const meta = await resolveConversationMeta(chatId);
  const businessId = meta.businessId;
  const customerId = meta.customerId;

  // Si no podemos derivar participantes, permitimos por compat (pero sigue protegido por requireAuth)
  if (!businessId || !customerId) return meta;

  const userId = req.user?.id;
  if (!userId) throw new Error('No user');

  if (userId === customerId) return meta;

  // Dueño del negocio
  const { data: biz } = await supabase.from('businesses').select('id, owner_id').eq('id', businessId).single();
  if (biz?.owner_id && biz.owner_id === userId) return meta;

  // Admin
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', userId).single();
  if (profile?.role === 'admin') return meta;

  const err = new Error('Forbidden');
  err.status = 403;
  throw err;
}

// Obtener previews (último mensaje) para múltiples conversaciones (requiere auth)
// Body: { ids: string[] }
router.post('/previews', requireAuth, async (req, res) => {
  try {
    const idsRaw = req.body?.ids;
    if (!Array.isArray(idsRaw)) return res.status(400).json({ error: 'ids requerido' });

    const ids = Array.from(
      new Set(
        idsRaw
          .map((v) => String(v || '').trim())
          .filter(Boolean),
      ),
    ).slice(0, 60);

    const previews = {};
    for (const chatId of ids) {
      try {
        await ensureChatAccess(req, chatId);
        const msg = await getLastMessage(chatId, req.user?.id);
        if (!msg) continue;

        previews[String(chatId)] = {
          text: msg?.text || '',
          senderId: msg?.sender_id || null,
          createdAt: msg?.created_at || null,
        };
      } catch {
        // Silenciar conversaciones no autorizadas
      }
    }

    return res.json({ previews });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Error getting chat previews', err);
    return res.status(500).json({ error: 'Error al obtener previews' });
  }
});

// Obtener mensajes de un chat (conversationId u orderId) (requiere auth)
router.get('/:chatId/messages', requireAuth, async (req, res) => {
  const { chatId } = req.params;
  try {
    // Chat debe ser siempre fresh: evita ETag/304 que rompen clientes que esperan JSON.
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');

    await ensureChatAccess(req, chatId);
    const msgs = await getMessages(chatId, req.user.id);
    return res.json({ messages: msgs });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Error getting messages', err);
    const status = err?.status || 500;
    return res.status(status).json({ error: status === 403 ? 'No autorizado' : 'Error al obtener mensajes' });
  }
});

// Enviar mensaje (fallback HTTP)
router.post('/:chatId/messages', requireAuth, async (req, res) => {
  const { chatId } = req.params;
  const payload = req.body || {};
  if (!payload.text) return res.status(400).json({ error: 'Texto requerido' });
  try {
    await ensureChatAccess(req, chatId);
    const msg = await addMessage(chatId, payload);
    return res.status(201).json({ message: msg });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Error adding message', err);
    const status = err?.status || 500;
    return res.status(status).json({ error: status === 403 ? 'No autorizado' : 'Error al guardar mensaje' });
  }
});

// Enviar imagen (fallback HTTP)
router.post('/:chatId/images', requireAuth, async (req, res) => {
  const { chatId } = req.params;
  const payload = req.body || {};
  if (!payload.dataUrl && !payload.imageDataUrl) return res.status(400).json({ error: 'Imagen requerida' });
  try {
    await ensureChatAccess(req, chatId);
    const msg = await addImageMessage(chatId, payload);
    return res.status(201).json({ message: msg });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Error adding image message', err);
    const status = err?.status || 500;
    return res.status(status).json({ error: status === 403 ? 'No autorizado' : 'Error al guardar imagen' });
  }
});

export default router;
