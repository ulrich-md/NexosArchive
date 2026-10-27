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

// --- Claude (principal) ------------------------------------------------------
// Decisión del dueño (2026-10-14): el router, la reformulación del hilo, la
// expansión del tema y la redacción pasan a Claude Haiku 5.5. El cupo
// gratuito de Gemini (20 al día por modelo) tumbaba respuestas en uso real.
// Gemini queda como respaldo si Claude falla, y para los vectores (Anthropic
// no ofrece embeddings).
export const anthropicApiKey = () => env('ANTHROPIC_API_KEY');
export const MODELO_CLAUDE = env('MODELO_CLAUDE') ?? 'claude-haiku-5-5';

// --- Gemini (respaldo y vectores) --------------------------------------------
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

// --- Búsqueda por significado ----------------------------------------------
/**
 * Un vector por artículo (título + autores + sección + temas + resumen).
 * Tiene que ser EXACTAMENTE el modelo y la dimensión con que `npm run
 * embeber` llenó `articulos_vectores`: un vector de otro modelo no es
 * comparable aunque mida lo mismo.
 *
 * Con el secreto VOYAGE_API_KEY el proveedor es Voyage (`voyage-4`, 1024,
 * migración 0012); sin él, Gemini (768, migraciones 0006/0007). La llave y la
 * migración se ponen juntas: ver 0012.
 */
export const voyageApiKey = () => env('VOYAGE_API_KEY');
export const usaVoyage = () => Boolean(voyageApiKey());
export const MODELO_VOYAGE = env('MODELO_VOYAGE') ?? 'voyage-4';
export const MODELO_EMBEDDINGS = env('MODELO_EMBEDDINGS') ?? 'gemini-embedding-001';
export const dimEmbeddings = () => (usaVoyage() ? 1024 : 768);
export const modeloEmbeddings = () => (usaVoyage() ? MODELO_VOYAGE : MODELO_EMBEDDINGS);
export const TIMEOUT_EMBEDDING_MS = entero('TIMEOUT_EMBEDDING_MS', 5_000);
/** Candidatos que la búsqueda híbrida le pasa al modelo para elegir y redactar. */
// 40 se quedaba corto en temas amplios: con "artículos sobre comida", dos
// crónicas de comida de Albrecht Mohrhardt Doger ("Aprender a comer en el
// Suntory", "Desayunos en Lotti") no llegaban ni a candidatas (2026-10-27).
// 120 fichas son ~13k tokens: poco más de un décimo de centavo con Haiku.
export const HIBRIDA_CANDIDATOS = entero('HIBRIDA_CANDIDATOS', 120);
/** Fichas que se enseñan si el modelo no pudo redactar (orden por RRF). */
export const HIBRIDA_SIN_REDACCION = 8;
/**
 * Si la obra de un autor tiene hasta estos textos, el modelo la lee completa
 * en vez de buscar en ella. Ángeles Mastretta tiene 876 (medido en vivo): a
 * ~70–90 tokens por ficha son ~60–80k tokens, debajo de los 100k donde Haiku
 * 5.5 cambia de tarifa. 1,000 es además el tope de filas de PostgREST.
 */
export const LECTURA_AUTOR_MAX = entero('LECTURA_AUTOR_MAX', 1000);
/** Fichas que lee el modelo para el panorama de una lista de catálogo
 *  (carriles/perfil.ts): ~20k tokens, unas décimas de centavo con Haiku. */
export const PERFIL_MUESTRA = entero('PERFIL_MUESTRA', 240);
/** Máximo de fichas citadas en una respuesta directa. */
/** Cuántos textos puede dejar en la lista (no cuántos cita en el texto). */
export const HIBRIDA_MAX_CITADAS = 40;
/**
 * Distancia coseno máxima para que un artículo que llegó SOLO por el vector
 * cuente como candidato (lo que también trae las palabras entra siempre). El
 * vector siempre devuelve vecinos aunque ninguno trate del tema: sin este
 * tope, esos vecinos son los "artículos sin relación". Sin calibrar contra
 * datos reales todavía: la traza enseña la distancia de cada búsqueda para
 * ajustarlo.
 */
export const HIBRIDA_DISTANCIA_MAX = (() => {
  const v = Number.parseFloat(env('HIBRIDA_DISTANCIA_MAX') ?? '');
  return Number.isFinite(v) && v > 0 && v < 2 ? v : 0.5;
})();

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
