// Edge Function `conversaciones` — el historial de quien inició sesión.
//
// Sin sesión, las conversaciones viven solo en el navegador. Con sesión
// (Google), se guardan en la tabla `conversaciones` (migración 0009) y el
// sidebar las enseña desde cualquier dispositivo.
//
// Deliberadamente independiente de `buscar/`, igual que `facetas`: sin
// imports cruzados, se despliega sola.
//
// Seguridad (CLAUDE.md sección 6): la tabla no tiene ninguna policy; esta
// función lee con service role y SIEMPRE filtra por el usuario del JWT, que se
// valida aquí con `auth.getUser` (la función se despliega con
// --no-verify-jwt porque el frontend llama con una llave publishable). El
// usuario nunca viene del cuerpo de la petición.
//
// Todo es POST con `accion`, como las otras funciones:
//   listar                       → { conversaciones: [{ id, titulo, actualizada_en }] }
//   leer     { id }              → { conversacion: { id, titulo, turnos, actualizada_en } | null }
//   guardar  { id, titulo, turnos } → { ok: true }
//   borrar   { id }              → { ok: true }
//   importar { conversaciones }  → { ok: true, n }   (las del navegador, al iniciar sesión)

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

function env(nombre: string): string | undefined {
  const v = Deno.env.get(nombre);
  return v && v.trim() !== '' ? v.trim() : undefined;
}

const ORIGENES_PERMITIDOS = (env('ORIGENES_PERMITIDOS') ?? '*')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

/** Una conversación larga con fichas pesa decenas de KB por turno. */
const MAX_BYTES_PETICION = 4_000_000;
const MAX_BYTES_CONVERSACION = 1_500_000;
const MAX_TURNOS = 100;
const MAX_IMPORTAR = 20;
const MAX_LISTAR = 50;
const PATRON_ID = /^[A-Za-z0-9._-]{8,64}$/;

function encabezadosCors(req: Request): Record<string, string> {
  const origen = req.headers.get('origin') ?? '';
  const permitido = ORIGENES_PERMITIDOS.includes('*')
    ? (origen || '*')
    : (ORIGENES_PERMITIDOS.includes(origen) ? origen : ORIGENES_PERMITIDOS[0] ?? '');
  return {
    'access-control-allow-origin': permitido,
    'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

function respuestaJson(cuerpo: unknown, estado: number, req: Request): Response {
  return new Response(JSON.stringify(cuerpo), {
    status: estado,
    headers: {
      ...encabezadosCors(req),
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

class ErrorConversaciones extends Error {
  constructor(
    readonly codigo: string,
    mensaje: string,
    readonly estado: number,
    readonly detalle?: string,
  ) {
    super(mensaje);
  }
}

// Sin tipos generados de la base: `any` deja escribir filas sin que el
// cliente infiera `never`.
// deno-lint-ignore no-explicit-any
let cliente: SupabaseClient<any> | null = null;
function bd() {
  if (!cliente) {
    const url = env('SUPABASE_URL');
    const llave = env('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !llave) throw new Error('Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY.');
    cliente = createClient(url, llave, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { 'x-archivo-nexos': 'conversaciones' } },
    });
  }
  return cliente;
}

async function usuarioDeLaPeticion(req: Request): Promise<string> {
  const m = (req.headers.get('authorization') ?? '').match(/^Bearer\s+(.+)$/i);
  const token = m?.[1]?.trim();
  // Sin sesión el navegador manda la llave publishable, que no es un usuario:
  // getUser la rechaza y cae aquí.
  const { data, error } = token ? await bd().auth.getUser(token) : { data: null, error: null };
  const id = data?.user?.id;
  if (!id) {
    throw new ErrorConversaciones(
      'NO_AUTENTICADO',
      'Inicia sesión para ver tus conversaciones guardadas.',
      401,
      error?.message,
    );
  }
  return id;
}

function idValido(v: unknown): string {
  if (typeof v !== 'string' || !PATRON_ID.test(v)) {
    throw new ErrorConversaciones('PETICION_INVALIDA', 'El id de la conversación no es válido.', 400);
  }
  return v;
}

interface Fila {
  usuario: string;
  id: string;
  titulo: string;
  turnos: unknown[];
  actualizada_en: string;
}

function filaValida(usuario: string, crudo: unknown): Fila {
  const c = (crudo ?? {}) as Record<string, unknown>;
  const id = idValido(c.id);
  const titulo = typeof c.titulo === 'string' ? c.titulo.trim().slice(0, 200) : '';
  if (!titulo) {
    throw new ErrorConversaciones('PETICION_INVALIDA', 'La conversación no trae título.', 400);
  }
  if (!Array.isArray(c.turnos) || c.turnos.length === 0) {
    throw new ErrorConversaciones('PETICION_INVALIDA', 'La conversación no trae turnos.', 400);
  }
  const turnos = c.turnos.slice(-MAX_TURNOS);
  if (JSON.stringify(turnos).length > MAX_BYTES_CONVERSACION) {
    throw new ErrorConversaciones(
      'CONVERSACION_DEMASIADO_GRANDE',
      'Esta conversación es demasiado larga para guardarse. Empieza un chat nuevo.',
      413,
    );
  }
  // La fecha la pone el navegador para respetar el orden de lo importado, pero
  // nunca en el futuro.
  const ms = typeof c.actualizada_en === 'number' ? c.actualizada_en : Date.parse(String(c.actualizada_en ?? ''));
  const actualizada_en = new Date(Number.isFinite(ms) ? Math.min(ms, Date.now()) : Date.now()).toISOString();
  return { usuario, id, titulo, turnos, actualizada_en };
}

async function atender(req: Request): Promise<unknown> {
  const texto = await req.text();
  if (texto.length > MAX_BYTES_PETICION) {
    throw new ErrorConversaciones('PETICION_DEMASIADO_GRANDE', 'La petición es demasiado grande.', 413);
  }
  let cuerpo: Record<string, unknown>;
  try {
    cuerpo = JSON.parse(texto || '{}');
  } catch {
    throw new ErrorConversaciones('CUERPO_INVALIDO', 'La petición no trae un cuerpo JSON válido.', 400);
  }

  const usuario = await usuarioDeLaPeticion(req);
  const tabla = () => bd().from('conversaciones');

  switch (cuerpo.accion) {
    case 'listar': {
      const { data, error } = await tabla()
        .select('id,titulo,actualizada_en')
        .eq('usuario', usuario)
        .order('actualizada_en', { ascending: false })
        .limit(MAX_LISTAR);
      if (error) throw error;
      return { conversaciones: data ?? [] };
    }
    case 'leer': {
      const { data, error } = await tabla()
        .select('id,titulo,turnos,actualizada_en')
        .eq('usuario', usuario)
        .eq('id', idValido(cuerpo.id))
        .maybeSingle();
      if (error) throw error;
      return { conversacion: data ?? null };
    }
    case 'guardar': {
      const { error } = await tabla().upsert(filaValida(usuario, cuerpo), { onConflict: 'usuario,id' });
      if (error) throw error;
      return { ok: true };
    }
    case 'borrar': {
      const { error } = await tabla().delete().eq('usuario', usuario).eq('id', idValido(cuerpo.id));
      if (error) throw error;
      return { ok: true };
    }
    case 'importar': {
      const lista = Array.isArray(cuerpo.conversaciones) ? cuerpo.conversaciones.slice(0, MAX_IMPORTAR) : [];
      const filas: Fila[] = [];
      for (const c of lista) {
        try {
          filas.push(filaValida(usuario, c));
        } catch {
          // Una conversación local dañada no impide subir las demás.
        }
      }
      if (filas.length > 0) {
        const { error } = await tabla().upsert(filas, { onConflict: 'usuario,id' });
        if (error) throw error;
      }
      return { ok: true, n: filas.length };
    }
    default:
      throw new ErrorConversaciones('PETICION_INVALIDA', 'Acción desconocida.', 400);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: encabezadosCors(req) });
  }
  if (req.method !== 'POST') {
    return respuestaJson(
      { error: { codigo: 'METODO_NO_PERMITIDO', mensaje: 'Esta función solo acepta POST.' } },
      405,
      req,
    );
  }
  try {
    return respuestaJson(await atender(req), 200, req);
  } catch (e) {
    if (e instanceof ErrorConversaciones) {
      return respuestaJson({ error: { codigo: e.codigo, mensaje: e.message, detalle: e.detalle } }, e.estado, req);
    }
    const detalle = e instanceof Error ? e.message : (e as { message?: string })?.message ?? String(e);
    console.error('[conversaciones]', detalle);
    return respuestaJson(
      { error: { codigo: 'BD_ERROR', mensaje: 'No se pudieron leer o guardar tus conversaciones.', detalle } },
      502,
      req,
    );
  }
});
