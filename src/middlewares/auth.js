import { supabase } from '../config/supabase.js';

export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (!token) return res.status(401).json({ error: 'No autorizado' });

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: 'Token inválido' });

    req.user = data.user;
    req.accessToken = token;
    return next();
  } catch (err) {
    return next(err);
  }
}

export function requireRole(allowedRoles) {
  return async (req, res, next) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'No autorizado' });

      const { data: profile, error } = await supabase
        .from('profiles')
        .select('role, business_id')
        .eq('id', req.user.id)
        .single();

      if (error || !profile) return res.status(403).json({ error: 'Acceso denegado' });
      if (!allowedRoles.includes(profile.role)) {
        return res.status(403).json({ error: 'Permisos insuficientes' });
      }

      req.profile = profile;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}
