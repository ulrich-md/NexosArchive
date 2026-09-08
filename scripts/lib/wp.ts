// Cliente para el WordPress de Nexos.
// Todo lo de aquí está verificado contra la API real el 2026-09-07; ver
// CLAUDE.md sección 2 para los hallazgos que corrigen el spec original.
import './red.js';
import he from 'he';

export const WP_BASE = (process.env.WP_BASE_URL ?? 'https://www.nexos.com.mx/wp-json/wp/v2').replace(/\/$/, '');
export const SITIO = WP_BASE.replace(/\/wp-json\/wp\/v2$/, '');

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

// Los números de la revista aparecen como categorías en dos formas:
// "1978 Enero" (id 4) y también solo el año, "1978" (id 3). Las dos son
// número de revista; ninguna es una sección temática.
const RE_NUMERO_CON_MES = new RegExp(`^(19|20)\\d{2}\\s+(${MESES.join('|')})$`, 'i');
const RE_NUMERO_SOLO_ANIO = /^(19|20)\d{2}$/;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Deja texto plano: decodifica entidades HTML (&#8211;, &amp;, &#8220;) y
 * quita etiquetas. El 14% de los títulos de Nexos traen <em> para los títulos
 * de obras; sin esto la ficha mostraría "<em>Audición</em>" literal.
 */
export function decode(texto: string | null | undefined): string {
  if (!texto) return '';
  const sinEtiquetas = texto.replace(/<[^>]*>/g, '');
  return he.decode(sinEtiquetas).replace(/\s+/g, ' ').trim();
}

export function esNumeroRevista(nombreCategoria: string): boolean {
  const n = nombreCategoria.trim();
  return RE_NUMERO_CON_MES.test(n) || RE_NUMERO_SOLO_ANIO.test(n);
}

export function esNumeroConMes(nombreCategoria: string): boolean {
  return RE_NUMERO_CON_MES.test(nombreCategoria.trim());
}

/**
 * Convierte "2009 Febrero" en 2009-02-01. Se usa para recuperar la fecha de
 * los artículos cuyo `date` viene corrupto: el número de la revista es
 * metadata del propio archivo, así que la fecha se recupera, no se inventa.
 */
export function fechaDesdeNumero(numero: string): string | null {
  const m = numero.trim().match(new RegExp(`^((?:19|20)\\d{2})(?:\\s+(${MESES.join('|')}))?$`, 'i'));
  if (!m) return null;
  const anio = m[1];
  const mes = m[2] ? String(MESES.indexOf(m[2].toLowerCase()) + 1).padStart(2, '0') : '01';
  return `${anio}-${mes}-01`;
}

interface ErrorWp extends Error {
  status?: number;
  code?: string;
  /** El servidor respondió 200 con un cuerpo que no es JSON válido. */
  jsonInvalido?: boolean;
}

/**
 * GET con reintento y backoff exponencial en 5xx/429. Un 400 se propaga tal
 * cual (rest_post_invalid_page_number es la señal de "terminaste", no un fallo).
 */
export async function fetchJson<T>(url: string, maxRetries = 6): Promise<{ data: T; headers: Headers }> {
  let intento = 0;
  let largoPrevio = -1;
  for (;;) {
    const res = await fetch(url);

    if (res.ok) {
      // Un 200 puede traer un cuerpo ilegible por dos razones distintas y hay
      // que separarlas, porque una se arregla reintentando y la otra no:
      //
      //  - Transporte: la respuesta llegó cortada. Se reintenta como un 5xx.
      //  - Servidor: el WordPress de Nexos emite JSON inválido. Verificado en
      //    cultura.nexos.com.mx, offset 3950: el cuerpo de un artículo trae una
      //    comilla sin escapar (`la práctica de "reseñar"`) y rompe el JSON.
      //    Reintentar da byte por byte lo mismo, así que se marca el error como
      //    `jsonInvalido` y quien llama decide (ver ingesta-subdominios.ts:
      //    parte el lote y, en el peor caso, se queda con la metadata).
      //
      // La señal para distinguirlas es el tamaño: dos cuerpos idénticos no son
      // un corte de red, son la respuesta real del servidor.
      const texto = await res.text();
      try {
        return { data: JSON.parse(texto) as T, headers: res.headers };
      } catch (e) {
        const determinista = texto.length === largoPrevio;
        if (determinista || intento >= maxRetries) {
          const err: ErrorWp = new Error(
            `Respuesta ilegible de ${url} (${texto.length} bytes): ${(e as Error).message}`,
          );
          err.jsonInvalido = determinista;
          throw err;
        }
        largoPrevio = texto.length;
        const espera = Math.min(30_000, 500 * 2 ** intento) + Math.random() * 250;
        console.warn(`  [reintento] JSON ilegible a los ${texto.length} bytes (intento ${intento + 1}/${maxRetries}), esperando ${Math.round(espera)}ms...`);
        await sleep(espera);
        intento++;
        continue;
      }
    }

    if (res.status === 400) {
      const cuerpo = (await res.json().catch(() => null)) as { code?: string } | null;
      const err: ErrorWp = new Error(`HTTP 400 en ${url}: ${cuerpo?.code ?? 'bad_request'}`);
      err.status = 400;
      err.code = cuerpo?.code;
      throw err;
    }

    const reintentable = res.status === 429 || res.status >= 500;
    if (!reintentable || intento >= maxRetries) {
      const texto = await res.text().catch(() => '');
      const err: ErrorWp = new Error(`HTTP ${res.status} en ${url}: ${texto.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }

    const espera = Math.min(30_000, 500 * 2 ** intento) + Math.random() * 250;
    console.warn(`  [reintento] HTTP ${res.status} (intento ${intento + 1}/${maxRetries}), esperando ${Math.round(espera)}ms...`);
    await sleep(espera);
    intento++;
  }
}

/** GET de HTML plano, con el mismo reintento que fetchJson. */
export async function fetchTexto(url: string, maxRetries = 4): Promise<string | null> {
  let intento = 0;
  for (;;) {
    const res = await fetch(url);
    if (res.ok) return res.text();
    if (res.status === 404) return null;

    const reintentable = res.status === 429 || res.status >= 500;
    if (!reintentable || intento >= maxRetries) return null;

    await sleep(Math.min(30_000, 500 * 2 ** intento) + Math.random() * 250);
    intento++;
  }
}

interface TerminoWp {
  id: number;
  name: string;
  slug?: string;
}

/** Pagina cualquier taxonomía de WP (categories, coauthors) y devuelve todos los términos. */
async function todosLosTerminos(taxonomia: string, delayMs: number): Promise<TerminoWp[]> {
  const terminos: TerminoWp[] = [];
  for (let page = 1; ; page++) {
    const url = `${WP_BASE}/${taxonomia}?per_page=100&page=${page}&_fields=id,name,slug`;
    let respuesta;
    try {
      respuesta = await fetchJson<TerminoWp[]>(url);
    } catch (err) {
      if ((err as ErrorWp).status === 400) break; // rest_post_invalid_page_number
      throw err;
    }
    if (respuesta.data.length === 0) break;
    terminos.push(...respuesta.data);
    await sleep(delayMs);
  }
  return terminos;
}

/** Mapa id -> nombre de categoría (números de revista y secciones). */
export async function construirMapaCategorias(delayMs = 300): Promise<Map<number, string>> {
  const mapa = new Map<number, string>();
  for (const cat of await todosLosTerminos('categories', delayMs)) {
    mapa.set(cat.id, decode(cat.name));
  }
  return mapa;
}

export interface CoautorWp {
  id: number;
  slug: string;
  nombreApi: string; // forma slug que devuelve la API: "carlos-monsivais"
}

/** Lista de coautores desde /wp/v2/coauthors (taxonomía pública, ~3,450 términos). */
export async function listarCoautores(delayMs = 300): Promise<CoautorWp[]> {
  return (await todosLosTerminos('coauthors', delayMs)).map((t) => ({
    id: t.id,
    slug: t.slug ?? '',
    nombreApi: decode(t.name),
  }));
}

/**
 * El nombre real del autor, con acentos, solo existe en la página pública del
 * autor: el h1 viene como "Nexos • Carlos Monsiváis". La API únicamente expone
 * la forma slug ("carlos-monsivais"), y reponerle los acentos a mano sería
 * inventar datos, que es justo lo que prohíbe la sección 7. Así que se recupera
 * de la página. Devuelve null si no se pudo obtener: sin nombre, no hay autor.
 */
export async function nombreRealDeCoautor(slug: string): Promise<string | null> {
  if (!slug) return null;
  const html = await fetchTexto(`${SITIO}/author/${slug}/`);
  if (!html) return null;

  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) {
    const texto = decode(h1[1]).replace(/^Nexos\s*[•·]\s*/, '').trim();
    if (texto && texto.toLowerCase() !== 'nexos') return texto;
    if (texto) return texto;
  }

  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title) {
    const texto = decode(title[1]).replace(/\s*[–-]\s*Nexos\s*$/i, '').trim();
    if (texto && !/^Nexos$/i.test(texto) && !/no encontrada/i.test(texto)) return texto;
  }

  return null;
}

/**
 * Resuelve el array `coauthors` de un post (IDs numéricos) a nombres reales
 * usando el mapa ya construido. Un ID que no esté en el mapa se descarta:
 * nunca se inventa un nombre a partir de un número.
 */
export function resolverAutores(
  coauthors: unknown,
  mapaAutores: Map<number, string>,
): { autores: string[]; confianza: 'wp' | 'ausente' } {
  const nombres = new Set<string>();

  if (Array.isArray(coauthors)) {
    for (const entrada of coauthors) {
      if (typeof entrada === 'number') {
        const nombre = mapaAutores.get(entrada);
        if (nombre) nombres.add(nombre);
      } else if (typeof entrada === 'string') {
        const nombre = decode(entrada);
        if (nombre) nombres.add(nombre);
      } else if (entrada && typeof entrada === 'object') {
        const obj = entrada as Record<string, unknown>;
        const candidato = obj.display_name ?? obj.name ?? obj.title;
        if (typeof candidato === 'string' && candidato.trim()) nombres.add(decode(candidato));
      }
    }
  }

  if (nombres.size === 0) return { autores: [], confianza: 'ausente' };
  return { autores: [...nombres], confianza: 'wp' };
}
