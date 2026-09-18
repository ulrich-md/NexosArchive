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

// --- Gemini -----------------------------------------------------------------
// El proyecto usa Gemini (decisión del dueño, por costo), no Claude como decía
// la sección 8 original del spec.
export const geminiApiKey = () => env('GEMINI_API_KEY');

/**
 * La cuota gratuita de Gemini es de 20 peticiones al día POR PROYECTO Y POR
 * MODELO (`GenerateRequestsPerDayPerProjectPerModel-FreeTier`), así que cada
 * modelo trae su propio cupo — la misma palanca que ya usa el enriquecimiento
 * masivo (`scripts/enriquecer.ts`). Estos siete están verificados contra la
 * API real. `llamarConHerramienta` los prueba en este orden y salta al
 * siguiente en cuanto uno agota su cuota del día, en vez de fallar y degradar
 * a las reglas con la cuota de los otros seis intacta.
 */
export const MODELOS_GEMINI = (env('GEMINI_MODELOS') ?? [
  'gemini-2.5-flash',
  'gemini-3-flash-preview',
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-flash-lite-latest',
].join(','))
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);

export const TIMEOUT_ROUTER_MS = entero('TIMEOUT_ROUTER_MS', 8_000);
/** Reloj de pared de toda la petición: nunca una pestaña congelada. */
export const TIMEOUT_TOTAL_MS = entero('TIMEOUT_TOTAL_MS', 30_000);
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
 * Acceso sin sesión a los tres carriles. Apagado por defecto (el archivo es
 * contenido de pago), pero es el modo previsto para producción: solo lo
 * conocerán los administradores de Nexos, así que la sesión no es la puerta
 * de acceso al archivo, es solo lo que conserva el historial de
 * conversaciones entre visitas (CLAUDE.md sección 6). El límite de 30
 * consultas/hora sigue aplicando a los anónimos, por IP en vez de por usuario.
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
export const CATALOGO_POR_PAGINA = entero('CATALOGO_POR_PAGINA', 4);
export const CATALOGO_POR_PAGINA_MAX = entero('CATALOGO_POR_PAGINA_MAX', 100);
export const APROXIMADOS_N = 5;
export const PREGUNTA_MAX_CARACTERES = 500;

/** Rango real del archivo. Nexos se fundó en 1978 (CLAUDE.md sección 0). */
export const ANIO_MIN = 1978;
export const ANIO_MAX = new Date().getUTCFullYear() + 1;
