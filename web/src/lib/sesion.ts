/**
 * Sesión de Supabase Auth.
 *
 * ⚠️ REGLA DURA (CLAUDE.md sección 6): este archivo expone ÚNICAMENTE la
 * superficie de autenticación. El cliente de Supabase no se exporta y no
 * debe exportarse nunca, porque exportarlo habilita
 * `supabase.from('articulos')` desde el navegador — que es exactamente lo
 * que baja el security score a 3/10 y filtra 56 años del archivo de pago.
 *
 * La lista blanca del dominio @nexos.com.mx se valida EN EL SERVIDOR
 * (Edge Function). Aquí no se valida nada: un check en el cliente es
 * decorativo.
 */

import { createClient, type SupabaseClient, type Session } from '@supabase/supabase-js';

export const URL_SUPABASE = (import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/$/, '');
export const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

export const HAY_BACKEND = Boolean(URL_SUPABASE && ANON_KEY);

let cliente: SupabaseClient | null = null;

function obtenerCliente(): SupabaseClient | null {
  if (!HAY_BACKEND) return null;
  if (!cliente) cliente = createClient(URL_SUPABASE, ANON_KEY);
  return cliente;
}

export interface Usuario {
  nombre: string | null;
  correo: string | null;
  avatar: string | null;
}

export async function obtenerSesion(): Promise<Session | null> {
  const c = obtenerCliente();
  if (!c) return null;
  const { data } = await c.auth.getSession();
  return data.session ?? null;
}

export async function obtenerTokenSesion(): Promise<string | null> {
  return (await obtenerSesion())?.access_token ?? null;
}

export function alCambiarSesion(fn: (sesion: Session | null) => void): () => void {
  const c = obtenerCliente();
  if (!c) return () => {};
  const { data } = c.auth.onAuthStateChange((_evento, sesion) => fn(sesion));
  return () => data.subscription.unsubscribe();
}

export function usuarioDeSesion(sesion: Session | null): Usuario | null {
  if (!sesion?.user) return null;
  const m = sesion.user.user_metadata ?? {};
  return {
    nombre: (m.full_name as string) ?? (m.name as string) ?? null,
    correo: sesion.user.email ?? null,
    avatar: (m.avatar_url as string) ?? null,
  };
}

export async function iniciarSesionGoogle(): Promise<void> {
  const c = obtenerCliente();
  if (!c) {
    throw new Error(
      'Falta configurar el acceso: define VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY.',
    );
  }
  const { error } = await c.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin },
  });
  if (error) throw new Error('No se pudo abrir el acceso con Google. Intenta de nuevo.');
}

export async function cerrarSesion(): Promise<void> {
  await obtenerCliente()?.auth.signOut();
}
