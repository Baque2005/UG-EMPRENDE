import express from 'express';
import { getMessages, addMessage } from '../chatService.js';

const router = express.Router();

// Obtener mensajes de una orden
router.get('/:orderId/messages', async (req, res) => {
  const { orderId } = req.params;
  try {
    const msgs = await getMessages(orderId);
    return res.json({ messages: msgs });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Error getting messages', err);
    return res.status(500).json({ error: 'Error al obtener mensajes' });
  }
});

// Enviar mensaje (fallback HTTP)
router.post('/:orderId/messages', async (req, res) => {
  const { orderId } = req.params;
  const payload = req.body || {};
  if (!payload.text) return res.status(400).json({ error: 'Texto requerido' });
  try {
    const msg = await addMessage(orderId, payload);
    return res.status(201).json({ message: msg });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Error adding message', err);
    return res.status(500).json({ error: 'Error al guardar mensaje' });
  }
});

export default router;
