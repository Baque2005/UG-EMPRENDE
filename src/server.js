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

const normalize = (u) => (typeof u === 'string' ? u.replace(/\/+$/u, '') : u);

const rawOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(normalize);

// En Render, esta variable suele estar disponible y apunta al dominio público.
const renderExternalUrl = normalize(process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || process.env.APP_URL || '');
if (renderExternalUrl && !rawOrigins.includes(renderExternalUrl)) rawOrigins.push(renderExternalUrl);

const isDev = String(process.env.NODE_ENV || '').toLowerCase() !== 'production';

function isAllowedSocketOrigin(origin) {
  // Socket.IO a veces pasa origin undefined (por ejemplo, herramientas o same-origin peculiar)
  if (!origin) return isDev;

  const normalizedOrigin = normalize(origin);

  // Allowlist explícita
  if (rawOrigins.includes(normalizedOrigin)) return true;

  // En desarrollo: permitir localhost/127.0.0.1 en cualquier puerto
  if (isDev) {
    return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/iu.test(String(normalizedOrigin));
  }

  return false;
}

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      try {
        if (isAllowedSocketOrigin(origin)) return callback(null, true);
        return callback(new Error(`Socket.IO CORS bloqueado para origin: ${origin}`));
      } catch (e) {
        return callback(e);
      }
    },
    methods: ['GET', 'POST'],
    credentials: true,
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

// Presence watch subscriptions (best-effort, in-memory)
// socketsWatchingUser: subjectUserId -> Set(socketId)
const socketsWatchingUser = new Map();
// watchedUsersBySocket: socketId -> Set(subjectUserId)
const watchedUsersBySocket = new Map();

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

function addPresenceWatch(socketId, subjectUserId) {
  if (!socketId || !subjectUserId) return;
  const sid = String(socketId);
  const uid = String(subjectUserId);
  const byUser = socketsWatchingUser.get(uid) || new Set();
  byUser.add(sid);
  socketsWatchingUser.set(uid, byUser);

  const bySocket = watchedUsersBySocket.get(sid) || new Set();
  bySocket.add(uid);
  watchedUsersBySocket.set(sid, bySocket);
}

function removeAllPresenceWatchesForSocket(socketId) {
  if (!socketId) return;
  const sid = String(socketId);
  const subjects = watchedUsersBySocket.get(sid);
  if (subjects) {
    for (const uid of subjects) {
      const set = socketsWatchingUser.get(uid);
      if (!set) continue;
      set.delete(sid);
      if (set.size === 0) socketsWatchingUser.delete(uid);
      else socketsWatchingUser.set(uid, set);
    }
  }
  watchedUsersBySocket.delete(sid);
}

function notifyPresenceWatchers(subjectUserId) {
  if (!subjectUserId) return;
  const uid = String(subjectUserId);
  const watchers = socketsWatchingUser.get(uid);
  if (!watchers || watchers.size === 0) return;

  for (const sid of watchers) {
    try {
      const s = io.sockets.sockets.get(String(sid));
      if (!s) continue;
      const viewerId = s.handshake.query?.userId || null;
      s.emit('presence:update', makePresencePayload({ viewerUserId: viewerId, subjectUserId: uid }));
    } catch {
      // ignore
    }
  }
}

io.on('connection', (socket) => {
  const { orderId, userId, userName } = socket.handshake.query || {};
  const thisUserId = userId || null;

  if (thisUserId) {
    setUserOnline(thisUserId);
    socket.join(`user:${thisUserId}`);

    // Inform watchers that this user is now online
    notifyPresenceWatchers(thisUserId);
  }

  async function resolveRoomId(inputId) {
    const meta = await resolveConversationMeta(inputId);
    return meta?.conversationId || inputId;
  }

  socket.on('privacy:update', async (payload) => {
    if (!thisUserId) return;
    try {
      setPrivacy(thisUserId, payload);

      // Inform watchers (global) that visibility may have changed
      notifyPresenceWatchers(thisUserId);

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

  // Subscribe to presence updates for specific users
  socket.on('presence:watch', (payload) => {
    try {
      if (!thisUserId) return;
      const raw = payload?.userIds;
      if (!Array.isArray(raw)) return;

      // Replace subscriptions for this socket
      removeAllPresenceWatchesForSocket(socket.id);

      const list = Array.from(
        new Set(
          raw
            .map((v) => String(v || '').trim())
            .filter(Boolean)
            .slice(0, 200),
        ),
      );

      for (const uid of list) {
        if (uid === String(thisUserId)) continue;
        addPresenceWatch(socket.id, uid);
      }

      // Send snapshot immediately
      for (const uid of list) {
        if (!uid) continue;
        socket.emit('presence:update', makePresencePayload({ viewerUserId: thisUserId, subjectUserId: uid }));
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

      // Si ya estaba unido a otra conversación, salir para evitar recibir mensajes duplicados.
      try {
        const prevConvo = socket.data?.conversationId;
        if (prevConvo && String(prevConvo) !== String(convoId)) {
          socket.leave(`chat:${prevConvo}`);
        }
      } catch {
        // ignore
      }

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

  // Typing indicator (ephemeral)
  socket.on('typing', async (payload) => {
    try {
      if (!thisUserId) return;
      const convoId = await resolveRoomId(payload?.conversationId || payload?.orderId || orderId);
      if (!convoId) return;

      const isTyping = Boolean(payload?.isTyping);

      // Determinar destinatario
      let recipientUserId = null;
      try {
        const meta = await resolveConversationMeta(convoId);
        const customerId = meta?.customerId || null;
        const ownerId = meta?.businessOwnerUserId || null;
        if (customerId && ownerId) {
          recipientUserId = thisUserId === customerId ? ownerId : (thisUserId === ownerId ? customerId : null);
        }
      } catch {
        recipientUserId = null;
      }

      const evt = {
        conversationId: convoId,
        userId: thisUserId,
        isTyping,
        at: new Date().toISOString(),
      };

      // A sockets en la sala (por si el otro está dentro del chat)
      io.to(`chat:${convoId}`).emit('typing', evt);

      // Y a la room del usuario (por si NO está en la sala)
      if (recipientUserId) io.to(`user:${recipientUserId}`).emit('typing', evt);
    } catch {
      // ignore
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

      // Deliver message ASAP (reduce perceived latency)
      if (outgoing) {
        try {
          const sender = String(outgoing?.sender_id || msg?.sender_id || payload?.senderId || thisUserId || '');
          const sockets = await io.in(`chat:${convoId}`).fetchSockets();

          // Batch blocked checks in 1 query (instead of per-socket awaits)
          const destUserIds = Array.from(new Set(
            sockets
              .map((s) => String(s.handshake.query?.userId || '').trim())
              .filter(Boolean)
              .filter((uid) => (sender ? uid !== sender : true)),
          ));

          let blockedSet = new Set();
          if (sender && destUserIds.length > 0) {
            try {
              const { data: blocks, error: blocksErr } = await supabase
                .from('user_blocks')
                .select('blocker_id')
                .eq('blocked_id', sender)
                .in('blocker_id', destUserIds);
              if (!blocksErr && Array.isArray(blocks)) {
                blockedSet = new Set(blocks.map((b) => String(b?.blocker_id || '')).filter(Boolean));
              }
            } catch {
              blockedSet = new Set();
            }
          }

          for (const s of sockets) {
            try {
              const destUserId = String(s.handshake.query?.userId || '').trim();
              if (sender && destUserId && destUserId !== sender && blockedSet.has(destUserId)) continue;
              s.emit('message', outgoing);
            } catch (e) {
              // eslint-disable-next-line no-console
              console.error('Error delivering to socket', e);
            }
          }
        } catch {
          // ignore
        }
      }

      // Notificaciones + preview en background (no bloquea la entrega del mensaje)
      void (async () => {
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
                chatEmailEnabled,
                suppressEmail: !chatEmailEnabled,
              },
            });

            io.to(`user:${recipientUserId}`).emit('chat:preview', {
              conversationId: convoId,
              text: msg?.text || '',
              senderId: sender,
              createdAt: msg?.created_at || null,
            });
          }

          if (sender) {
            io.to(`user:${sender}`).emit('chat:preview', {
              conversationId: convoId,
              text: msg?.text || '',
              senderId: sender,
              createdAt: msg?.created_at || null,
            });
          }
        } catch {
          // ignore
        }
      })();
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
    // Cleanup global watches
    removeAllPresenceWatchesForSocket(socket.id);

    if (!thisUserId) return;
    await setUserOffline(thisUserId);

    // Inform watchers that this user is now offline
    notifyPresenceWatchers(thisUserId);
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
