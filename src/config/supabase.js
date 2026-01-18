import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error('Faltan variables SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en .env');
}

// Cliente “admin” (SERVICE_ROLE) para operaciones de DB/Storage desde el servidor.
// Importante: no usarlo para flujos de auth (signUp/signIn) porque el SDK puede
// fijar una sesión en memoria y luego mandar JWT de usuario, aplicando RLS.
export const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

// Cliente para Auth (preferible ANON). Se mantiene separado para evitar que
// la sesión de usuario afecte a las queries DB hechas con el cliente admin.
export const supabaseAuth = createClient(supabaseUrl, anonKey || serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});
