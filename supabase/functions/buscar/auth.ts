// Autenticación y lista blanca de dominio, validadas EN EL SERVIDOR
// (CLAUDE.md sección 6). El cliente no decide nada de esto.

import { createClient } from '@supabase/supabase-js';
import {
  ACCESO_ANONIMO,
  DOMINIOS_PERMITIDOS,
  supabaseServiceRole,
  supabaseUrl,
} from './config.ts';
import { ErrorBuscar } from './errores.ts';

export interface Sesion {
  /** null solo cuando ACCESO_ANONIMO está encendido. */
  usuario_id: string | null;
  correo: string | null;
  anonimo: boolean;
}

function jwtDeLaPeticion(req: Request): string | null {
  const cabecera = req.headers.get('authorization') ?? '';
  const m = cabecera.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1].trim();
  // El gateway de Supabase manda la anon key como Bearer cuando no hay sesión;
  // una anon key no es un JWT de usuario y no debe pasar como tal.
  return token.length > 0 ? token : null;
}

export async function autenticar(req: Request): Promise<Sesion> {
  const token = jwtDeLaPeticion(req);

  if (!token) {
    if (ACCESO_ANONIMO) return { usuario_id: null, correo: null, anonimo: true };
    throw new ErrorBuscar(
      'NO_AUTENTICADO',
      'Inicia sesión con tu correo de Nexos para consultar el archivo.',
      { sugerencia: 'El archivo es contenido de pago: no se consulta sin sesión.' },
    );
  }

  const anon = createClient(supabaseUrl(), supabaseServiceRole(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await anon.auth.getUser(token);
  const usuario = data?.user ?? null;

  if (error || !usuario) {
    if (ACCESO_ANONIMO) return { usuario_id: null, correo: null, anonimo: true };
    throw new ErrorBuscar(
      'NO_AUTENTICADO',
      'Tu sesión venció. Vuelve a entrar con tu correo de Nexos.',
      { detalle: error?.message },
    );
  }

  const correo = (usuario.email ?? '').toLowerCase();
  const dominio = correo.split('@')[1] ?? '';
  if (!DOMINIOS_PERMITIDOS.includes(dominio)) {
    throw new ErrorBuscar(
      'DOMINIO_NO_AUTORIZADO',
      'Esta herramienta es solo para la redacción de Nexos.',
      {
        detalle: `El dominio ${dominio || '(sin correo)'} no está en la lista blanca.`,
        sugerencia: `Entra con un correo @${DOMINIOS_PERMITIDOS[0]}.`,
      },
    );
  }

  return { usuario_id: usuario.id, correo, anonimo: false };
}
