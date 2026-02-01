import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import { fileURLToPath } from 'url';

import { errorHandler } from './middlewares/errorHandler.js';
import { notFound } from './middlewares/notFound.js';

import healthRoutes from './routes/healthRoutes.js';
import authRoutes from './routes/authRoutes.js';
import businessRoutes from './routes/businessRoutes.js';
import productRoutes from './routes/productRoutes.js';
import orderRoutes from './routes/orderRoutes.js';
import reportRoutes from './routes/reportRoutes.js';
import notificationRoutes from './routes/notificationRoutes.js';
import pushRoutes from './routes/pushRoutes.js';
import paymentMethodRoutes from './routes/paymentMethodRoutes.js';
import addressRoutes from './routes/addressRoutes.js';
import userSettingsRoutes from './routes/userSettingsRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import favoriteRoutes from './routes/favoriteRoutes.js';
import chatRoutes from './routes/chatRoutes.js';
import userBlockRoutes from './routes/userBlockRoutes.js';

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Servir archivos estáticos del frontend (build Vite en backend/dist)
const staticPath = path.join(__dirname, '..', 'dist');
app.use(express.static(staticPath));

// Leer orígenes desde env y normalizar (quitar slash final)
const rawOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const normalize = (u) => (typeof u === 'string' ? u.replace(/\/+$/u, '') : u);
const allowedOrigins = rawOrigins.map(normalize);

/* eslint-disable no-console */
console.log('CORS_ORIGIN env:', process.env.CORS_ORIGIN);
console.log('allowedOrigins (normalized):', allowedOrigins);
/* eslint-enable no-console */

// Helmet con CSP personalizada: permitir imágenes desde el dominio del proyecto y Unsplash
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https://sgidgdgdqqkzcobshbsg.supabase.co', 'https://images.unsplash.com'],
        mediaSrc: ["'self'", 'data:', 'https://sgidgdgdqqkzcobshbsg.supabase.co'],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'", 'https://sgidgdgdqqkzcobshbsg.supabase.co'],
      },
    },
  }),
);

// Forzar CSP explícita en la respuesta usando la URL de Supabase desde .env.
// Esto ayuda si algún proxy/cache elimina o no aplica las cabeceras de Helmet.
const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/+$/u, '');
const forcedCsp = [
  "default-src 'self'",
  `img-src 'self' data: ${supabaseUrl} https://images.unsplash.com`,
  `media-src 'self' data: ${supabaseUrl}`,
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  `connect-src 'self' ${supabaseUrl}`,
].join('; ');

app.use((req, res, next) => {
  if (forcedCsp) res.setHeader('Content-Security-Policy', forcedCsp);
  next();
});
app.use(morgan('dev'));
app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true); // postman/curl
      const normalizedOrigin = normalize(origin);
      if (allowedOrigins.includes(normalizedOrigin)) return callback(null, true);
      return callback(new Error(`CORS bloqueado para origen: ${origin}`));
    },
    credentials: true,
  }),
);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/api/health', healthRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/business', businessRoutes);
app.use('/api/products', productRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/payment-methods', paymentMethodRoutes);
app.use('/api/addresses', addressRoutes);
app.use('/api/favorites', favoriteRoutes);
app.use('/api/user-settings', userSettingsRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/users', userBlockRoutes);

// Fallback para SPA: devolver index.html para rutas que no sean API
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  if (req.method !== 'GET') return next();
  const indexFile = path.join(staticPath, 'index.html');
  return res.sendFile(indexFile, (err) => {
    if (err) return next(err);
    return null;
  });
});

app.use(notFound);
app.use(errorHandler);

export default app;
