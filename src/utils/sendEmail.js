// sendEmail util removed: email confirmation now handled by Supabase (confirmation links).
// Esta función ya no se usa. Si por alguna razón se importa aún, lanzar un error claro.
export function sendEmail() {
  throw new Error('sendEmail no está disponible: la aplicación usa confirmación nativa de Supabase.');
}
