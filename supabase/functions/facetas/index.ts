// Edge Function `facetas` — alimenta el sidebar (CLAUDE.md sección 3, mejora
// 2): autores, secciones y décadas del archivo, más el total y el rango de
// años para el subtítulo del home. Tiene que responder en < 1 s, así que lee
// de las vistas materializadas (autores_conteo, secciones_conteo,
// decadas_conteo — migraciones 0001 y 0005), nunca cuenta en vivo.
//
// Deliberadamente independiente de `buscar/`: sin imports cruzados, para que
// se pueda desplegar sola sin arrastrar el resto de la función de búsqueda.
//
// Seguridad (sección 6): SIEMPRE service role. Las tablas y vistas
// materializadas no tienen ninguna policy de SELECT para anon/authenticated;
// esta función es el único camino de lectura, igual que `buscar`.

import { createClient } from 'jsr:@supabase/supabase-js@2';

function env(nombre: string): string | undefined {
  const v = Deno.env.get(nombre);
  return v && v.trim() !== '' ? v.trim() : undefined;
}

const ORIGENES_PERMITIDOS = (env('ORIGENES_PERMITIDOS') ?? '*')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

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

function respuestaErrorTipada(
  codigo: string,
  mensaje: string,
  estado: number,
  detalle: string | undefined,
  req: Request,
): Response {
  return respuestaJson({ error: { codigo, mensaje, detalle } }, estado, req);
}

let cliente: ReturnType<typeof createClient> | null = null;
function bd() {
  if (!cliente) {
    const url = env('SUPABASE_URL');
    const llave = env('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !llave) {
      throw new Error('Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY.');
    }
    cliente = createClient(url, llave, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { 'x-archivo-nexos': 'facetas' } },
    });
  }
  return cliente;
}

interface Faceta {
  nombre: string;
  n: number;
}

interface RespuestaFacetas {
  autores: Faceta[];
  secciones: Faceta[];
  decadas: Faceta[];
  total_articulos: number;
  anio_min: number | null;
  anio_max: number | null;
}

// Cacheado en el isolate: las vistas materializadas solo cambian cuando corre
// la ingesta (una vez al día, no en cada visita), así que recalcular en cada
// petición sería trabajo de sobra. 5 minutos basta para que un refresco de
// la ingesta se refleje pronto sin pegarle a la base en cada carga del sidebar.
const TTL_MS = 5 * 60 * 1000;
let cache: { cargado_en: number; datos: RespuestaFacetas } | null = null;

async function listaDe(vista: string, columna: string, limite: number): Promise<Faceta[]> {
  const { data, error } = await bd()
    .from(vista)
    .select(`${columna},n`)
    .order('n', { ascending: false })
    .limit(limite);
  if (error) throw new Error(`lectura de ${vista}: ${error.message}`);
  return (data ?? [])
    .filter((f: Record<string, unknown>) => typeof f[columna] === 'string' && f.n != null)
    .map((f: Record<string, unknown>) => ({ nombre: String(f[columna]), n: Number(f.n) }));
}

async function calcular(): Promise<RespuestaFacetas> {
  const [autores, secciones, decadas] = await Promise.all([
    listaDe('autores_conteo', 'autor', 20_000),
    listaDe('secciones_conteo', 'seccion', 1_000),
    listaDe('decadas_conteo', 'decada', 10),
  ]);

  const { count, error: errConteo } = await bd()
    .from('articulos')
    .select('id', { count: 'exact', head: true });
  if (errConteo) throw new Error(`conteo de articulos: ${errConteo.message}`);

  const extremo = async (asc: boolean): Promise<number | null> => {
    const { data, error } = await bd()
      .from('articulos')
      .select('anio_pub')
      .order('anio_pub', { ascending: asc })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`rango de años: ${error.message}`);
    return (data as { anio_pub: number } | null)?.anio_pub ?? null;
  };
  const [anio_min, anio_max] = await Promise.all([extremo(true), extremo(false)]);

  return { autores, secciones, decadas, total_articulos: count ?? 0, anio_min, anio_max };
}

async function facetasCacheadas(): Promise<RespuestaFacetas> {
  const ahora = Date.now();
  if (cache && ahora - cache.cargado_en < TTL_MS) return cache.datos;
  const datos = await calcular();
  cache = { cargado_en: ahora, datos };
  return datos;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: encabezadosCors(req) });
  }
  if (req.method !== 'POST') {
    return respuestaErrorTipada('METODO_NO_PERMITIDO', 'Esta función solo acepta POST.', 405, undefined, req);
  }

  try {
    const datos = await facetasCacheadas();
    return respuestaJson(datos, 200, req);
  } catch (e) {
    const mensaje = e instanceof Error ? e.message : String(e);
    console.error('[facetas]', mensaje);
    return respuestaErrorTipada(
      'BD_ERROR',
      'No se pudo leer la lista de autores y secciones.',
      502,
      mensaje,
      req,
    );
  }
});
