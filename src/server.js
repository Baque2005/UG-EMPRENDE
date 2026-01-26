import 'dotenv/config';
import http from 'http';
import { Server } from 'socket.io';
import app from './app.js';
import { addMessage } from './chatService.js';

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

io.on('connection', (socket) => {
  const { orderId, userId, userName } = socket.handshake.query || {};
  // Allow client to explicitly join rooms: 'order:<orderId>'
  socket.on('joinOrder', (roomId) => {
    if (!roomId) return;
    socket.join(`order:${roomId}`);
  });

  socket.on('message', async (payload) => {
    const roomId = payload.orderId || orderId;
    if (!roomId || !payload?.text) return;
    try {
      const msg = await addMessage(roomId, {
        text: payload.text,
        senderId: payload.senderId || userId || null,
        senderName: payload.senderName || userName || 'Anon',
      });
      io.to(`order:${roomId}`).emit('message', msg);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Error saving message (socket):', err);
    }
  });
});

server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Backend listo en http://localhost:${port}`);
});
