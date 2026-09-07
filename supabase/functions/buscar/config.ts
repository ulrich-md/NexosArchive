// Configuración de la Edge Function `buscar`. Todo por variable de entorno:
// ninguna llave vive en el repo ni en el frontend (CLAUDE.md sección 6).

import { ErrorBuscar } from './errores.ts';

function env(nombre: string): string | undefined {
  const v = Deno.env.get(nombre);
  return v && v.trim() !== '' ? v.trim() : undefined;
}

function entero(nombre: string, porDefecto: number): number {
  const v = env(nombre);
  if (!v) return porDefecto;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : porDefecto;
}

function bandera(nombre: string, porDefecto = false): boolean {
  const v = env(nombre)?.toLowerCase();
  if (v === undefined) return porDefecto;
  return v === 'true' || v === '1' || v === 'si' || v === 'sí';
}

export function obligatorio(nombre: string): string {
  const v = env(nombre);
  if (!v) {
    throw new ErrorBuscar(
      'CONFIG_FALTANTE',
      'El servidor no está configurado por completo. Avisa a quien administra el archivo.',
      { detalle: `Falta la variable de entorno ${nombre}.` },
    );
  }
  return v;
}

// --- Supabase ---------------------------------------------------------------
// SIEMPRE service role. La anon key no aparece en esta función ni por error:
// toda lectura del archivo pasa por aquí (CLAUDE.md sección 6).
export const supabaseUrl = () => obligatorio('SUPABASE_URL');
export const supabaseServiceRole = () => obligatorio('SUPABASE_SERVICE_ROLE_KEY');

// --- Anthropic --------------------------------------------------------------
export const anthropicApiKey = () => env('ANTHROPIC_API_KEY');

/** Router: barato y rápido (CLAUDE.md sección 8). */
export const MODELO_ROUTER = env('MODELO_ROUTER') ?? 'claude-haiku-4-5';
/** Redacción de la síntesis del modo panorama. */
export const MODELO_SINTESIS = env('MODELO_SINTESIS') ?? 'claude-sonnet-5';
/** Rerank de la fase 2 (top 40 → top 8). */
export const MODELO_RERANK = env('MODELO_RERANK') ?? 'claude-haiku-4-5';

export const TIMEOUT_ROUTER_MS = entero('TIMEOUT_ROUTER_MS', 8_000);
export const TIMEOUT_SINTESIS_MS = entero('TIMEOUT_SINTESIS_MS', 25_000);
export const MAX_TOKENS_ROUTER = entero('MAX_TOKENS_ROUTER', 1_024);
export const MAX_TOKENS_SINTESIS = entero('MAX_TOKENS_SINTESIS', 8_000);

// --- Acceso -----------------------------------------------------------------
/** Lista blanca de dominios, validada en el servidor (CLAUDE.md sección 6). */
export const DOMINIOS_PERMITIDOS = (env('DOMINIOS_PERMITIDOS') ?? 'nexos.com.mx')
  .split(',')
  .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
  .filter(Boolean);

/**
 * Acceso sin sesión. Apagado por defecto: el archivo es contenido de pago.
 * Si se enciende, los anónimos SOLO tienen el carril `catalogo` (cero LLM),
 * porque no hay a quién cobrarle el límite de 30 consultas/hora.
 */
export const ACCESO_ANONIMO = bandera('ACCESO_ANONIMO', false);

export const LIMITE_CONSULTAS_HORA = entero('LIMITE_CONSULTAS_HORA', 30);

export const ORIGENES_PERMITIDOS = (env('ORIGENES_PERMITIDOS') ?? '*')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

// --- Fase 2 -----------------------------------------------------------------
/**
 * Bandera de la fase 2 (cuerpo + chunks + embeddings). Apagada mientras no
 * exista el cuerpo de los artículos (CLAUDE.md sección 2, "Las dos fases").
 * Con la bandera apagada, el carril `hibrida` NO se cae en silencio: devuelve
 * un aviso tipado y degrada al carril que sí puede responder.
 */
export const FASE2_ACTIVA = bandera('FASE2_ACTIVA', false);
/** URL del proveedor de embeddings (fase 2). Sin esto la bandera no sirve. */
export const EMBEDDINGS_URL = () => env('EMBEDDINGS_URL');
export const EMBEDDINGS_API_KEY = () => env('EMBEDDINGS_API_KEY');
export const EMBEDDINGS_MODELO = env('EMBEDDINGS_MODELO') ?? '';
/** Nombre de la función RPC de búsqueda vectorial que crea la fase 2. */
export const RPC_CHUNKS_VECTOR = env('RPC_CHUNKS_VECTOR') ?? 'buscar_chunks_vector';

// --- Límites de consulta ----------------------------------------------------
export const PANORAMA_MIN_FILAS = entero('PANORAMA_MIN_FILAS', 200);
export const PANORAMA_MAX_FILAS = entero('PANORAMA_MAX_FILAS', 400);
export const CATALOGO_POR_PAGINA = entero('CATALOGO_POR_PAGINA', 20);
export const CATALOGO_POR_PAGINA_MAX = entero('CATALOGO_POR_PAGINA_MAX', 100);
export const APROXIMADOS_N = 5;
export const PREGUNTA_MAX_CARACTERES = 500;

/** Rango real del archivo. Nexos se fundó en 1978 (CLAUDE.md sección 0). */
export const ANIO_MIN = 1978;
export const ANIO_MAX = new Date().getUTCFullYear() + 1;
