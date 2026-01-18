export function errorHandler(err, req, res, next) {
  const status = Number(err?.statusCode) || 500;
  const message = err?.message || 'Error interno';

  if (process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.error(err);
  }

  res.status(status).json({ error: message });
}
