import 'dotenv/config';
import http from 'http';
import { Server } from 'socket.io';
import app from './app.js';
import { addImageMessage, addMessage, resolveConversationMeta } from './chatService.js';
import { isBlockedBy } from './userService.js';
import { createNotification } from './utils/createNotification.js';
import { supabase } from './config/supabase.js';

const port = Number(process.env.PORT) || 4000;

const server = http.createServer(app);

const rawOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const io = new Server(server, {
  cors: {
    origin: rawOrigins,
    methods: ['GET', 'POST'],
  },
});

// Simple in-memory presence tracking (best-effort)
const connectionsByUser = new Map(); // userId -> count
const lastSeenByUser = new Map(); // userId -> ISO

// Per-user privacy settings (best-effort, in-memory)
// showConnectionStatus=false => nadie ve tu online/lastSeen, y tú tampoco ves el de otros.
// showReadReceipts=false => no se emiten ni se reciben read receipts.
const privacyByUser = new Map(); // userId -> { showConnectionStatus, showReadReceipts }
const chatEmailByUser = new Map(); // userId -> boolean

function getPrivacy(userId) {
  if (!userId) return { showConnectionStatus: true, showReadReceipts: true };
  const p = privacyByUser.get(userId);
  return {
    showConnectionStatus: p?.showConnectionStatus !== false,
    showReadReceipts: p?.showReadReceipts !== false,
  };
}

function setPrivacy(userId, next) {
  if (!userId) return;
  const current = getPrivacy(userId);
  privacyByUser.set(userId, {
    showConnectionStatus: typeof next?.showConnectionStatus === 'boolean' ? next.showConnectionStatus : current.showConnectionStatus,
    showReadReceipts: typeof next?.showReadReceipts === 'boolean' ? next.showReadReceipts : current.showReadReceipts,
  });
}

function setUserOnline(userId) {
  if (!userId) return;
  const count = (connectionsByUser.get(userId) || 0) + 1;
  connectionsByUser.set(userId, count);
}

async function setUserOffline(userId) {
  if (!userId) return;
  const nextCount = Math.max(0, (connectionsByUser.get(userId) || 0) - 1);
  if (nextCount === 0) connectionsByUser.delete(userId);
  else connectionsByUser.set(userId, nextCount);

  const now = new Date().toISOString();
  lastSeenByUser.set(userId, now);

  // Persistir last seen en profiles si existe la columna (best-effort)
  try {
    await supabase.from('profiles').update({ last_seen_at: now }).eq('id', userId);
  } catch {
    // ignore
  }
}

function isUserOnline(userId) {
  return (connectionsByUser.get(userId) || 0) > 0;
}

function getLastSeen(userId) {
  return lastSeenByUser.get(userId) || null;
}

function makePresencePayload({ viewerUserId, subjectUserId }) {
  const viewer = getPrivacy(viewerUserId);
  const subject = getPrivacy(subjectUserId);

  // Si el viewer decidió ocultar estado, no ve nada de otros.
  if (!viewer.showConnectionStatus) {
    return { userId: subjectUserId, visible: false, online: false, lastSeenAt: null };
  }

  // Si el subject decidió ocultar estado, nadie lo ve.
  if (!subject.showConnectionStatus) {
    return { userId: subjectUserId, visible: false, online: false, lastSeenAt: null };
  }

  const online = isUserOnline(subjectUserId);
  return {
    userId: subjectUserId,
    visible: true,
    online,
    lastSeenAt: online ? null : getLastSeen(subjectUserId),
  };
}

io.on('connection', (socket) => {
  const { orderId, userId, userName } = socket.handshake.query || {};
  const thisUserId = userId || null;

  if (thisUserId) {
    setUserOnline(thisUserId);
    socket.join(`user:${thisUserId}`);
  }

  async function resolveRoomId(inputId) {
    const meta = await resolveConversationMeta(inputId);
    return meta?.conversationId || inputId;
  }

  socket.on('privacy:update', async (payload) => {
    if (!thisUserId) return;
    try {
      setPrivacy(thisUserId, payload);

      // Si ya está en una conversación, actualiza la presencia visible/invisible inmediatamente.
      const convoId = socket.data?.conversationId;
      if (!convoId) return;

      const sockets = await io.in(`chat:${convoId}`).fetchSockets();
      for (const s of sockets) {
        const viewerId = s.handshake.query?.userId || null;
        s.emit('presence:update', makePresencePayload({ viewerUserId: viewerId, subjectUserId: thisUserId }));
      }
    } catch {
      // ignore
    }
  });

  socket.on('chat:emailNotifications', (payload) => {
    if (!thisUserId) return;
    const enabled = Boolean(payload?.enabled);
    chatEmailByUser.set(thisUserId, enabled);
  });

  socket.on('joinOrder', async (roomId) => {
    if (!roomId) return;
    try {
      const convoId = await resolveRoomId(roomId);
      socket.join(`chat:${convoId}`);
      socket.data = socket.data || {};
      socket.data.conversationId = convoId;

      // Presence exchange for this conversation
      try {
        const meta = await resolveConversationMeta(convoId);
        const customerId = meta?.customerId || null;
        const ownerId = meta?.businessOwnerUserId || null;
        const participants = [customerId, ownerId].filter(Boolean);

        // Inform other sockets in room about this user's presence (respect privacy)
        if (thisUserId) {
          const sockets = await io.in(`chat:${convoId}`).fetchSockets();
          for (const s of sockets) {
            if (s.id === socket.id) continue;
            const viewerId = s.handshake.query?.userId || null;
            s.emit('presence:update', makePresencePayload({ viewerUserId: viewerId, subjectUserId: thisUserId }));
          }
        }

        // Send current presence snapshot to this socket (respect privacy)
        for (const pid of participants) {
          socket.emit('presence:update', makePresencePayload({ viewerUserId: thisUserId, subjectUserId: pid }));
        }
      } catch {
        // ignore
      }
    } catch (e) {
      socket.join(`chat:${roomId}`);
    }
  });

  socket.on('message', async (payload) => {
    const roomIdRaw = payload.orderId || orderId;
    const hasText = typeof payload?.text === 'string' && payload.text.trim().length > 0;
    const hasImage = typeof payload?.imageDataUrl === 'string' && payload.imageDataUrl.startsWith('data:');
    if (!roomIdRaw || (!hasText && !hasImage)) return;
    try {
      const convoId = await resolveRoomId(roomIdRaw);
      const msg = hasImage
        ? await addImageMessage(convoId, {
          imageDataUrl: payload.imageDataUrl,
          caption: payload.caption || '',
          senderId: payload.senderId || userId || null,
          senderName: payload.senderName || userName || 'Anon',
        })
        : await addMessage(convoId, {
          text: payload.text,
          senderId: payload.senderId || userId || null,
          senderName: payload.senderName || userName || 'Anon',
        });

      const outgoing = msg ? { ...msg, clientId: payload?.clientId || null } : null;

      // Crear notificación de "nuevo mensaje" al destinatario (best-effort)
      try {
        const meta = await resolveConversationMeta(convoId);
        const sender = msg?.sender_id || payload.senderId || thisUserId || null;
        const customerId = meta?.customerId || null;
        const ownerId = meta?.businessOwnerUserId || null;

        const recipientUserId = (() => {
          if (!sender) return null;
          if (sender && customerId && sender === customerId) return ownerId;
          if (sender && ownerId && sender === ownerId) return customerId;
          return null;
        })();

        if (recipientUserId) {
          const rawText = String(msg?.text || '');
          const preview = rawText.startsWith('__img__:') ? '📷 Imagen' : rawText.slice(0, 120);
          const chatEmailEnabled = chatEmailByUser.get(recipientUserId) === true;
          await createNotification({
            userId: recipientUserId,
            title: 'Nuevo mensaje',
            message: preview,
            meta: {
              kind: 'chat',
              conversationId: convoId,
              url: `/chat?conversationId=${encodeURIComponent(convoId)}`,
              suppressEmail: !chatEmailEnabled,
            },
          });
        }
      } catch {
        // ignore
      }

      // Deliver message only to sockets whose user has NOT blocked the sender
      const sockets = await io.in(`chat:${convoId}`).fetchSockets();
      for (const s of sockets) {
        try {
          const destUserId = s.handshake.query?.userId || null;
          if (destUserId) {
            const blocked = await isBlockedBy(destUserId, outgoing?.sender_id || msg?.sender_id);
            if (blocked) continue; // skip delivery
          }
          if (outgoing) s.emit('message', outgoing);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error('Error delivering to socket', e);
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Error saving message (socket):', err);
    }
  });

  // Read receipt (ephemeral)
  socket.on('read', async (payload) => {
    try {
      if (!thisUserId) return;
      const senderPrivacy = getPrivacy(thisUserId);
      if (!senderPrivacy.showReadReceipts) return;

      const convoId = await resolveRoomId(payload?.conversationId || payload?.orderId || orderId);
      if (!convoId) return;

      const sockets = await io.in(`chat:${convoId}`).fetchSockets();
      for (const s of sockets) {
        const viewerId = s.handshake.query?.userId || null;
        const viewerPrivacy = getPrivacy(viewerId);
        if (!viewerPrivacy.showReadReceipts) continue;

        s.emit('read', {
          conversationId: convoId,
          userId: thisUserId,
          lastReadMessageId: payload?.lastReadMessageId || null,
          readAt: payload?.readAt || new Date().toISOString(),
        });
      }
    } catch {
      // ignore
    }
  });

  socket.on('disconnect', async () => {
    if (!thisUserId) return;
    await setUserOffline(thisUserId);
    try {
      const convoId = socket.data?.conversationId;
      if (convoId) {
        const sockets = await io.in(`chat:${convoId}`).fetchSockets();
        for (const s of sockets) {
          const viewerId = s.handshake.query?.userId || null;
          s.emit('presence:update', makePresencePayload({ viewerUserId: viewerId, subjectUserId: thisUserId }));
        }
      }
    } catch {
      // ignore
    }
  });
});

server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Backend listo en http://localhost:${port}`);
});
