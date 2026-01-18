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
import paymentMethodRoutes from './routes/paymentMethodRoutes.js';
import addressRoutes from './routes/addressRoutes.js';
import userSettingsRoutes from './routes/userSettingsRoutes.js';
import adminRoutes from './routes/adminRoutes.js';

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Servir archivos estáticos del frontend (build Vite en backend/dist)
const staticPath = path.join(__dirname, '..', 'dist');
app.use(express.static(staticPath));

const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(helmet());
app.use(morgan('dev'));
app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true); // postman/curl
      if (allowedOrigins.includes(origin)) return callback(null, true);
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
app.use('/api/payment-methods', paymentMethodRoutes);
app.use('/api/addresses', addressRoutes);
app.use('/api/user-settings', userSettingsRoutes);

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
