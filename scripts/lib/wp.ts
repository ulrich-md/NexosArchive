// Cliente mínimo para el WordPress de Nexos. Ver CLAUDE.md sección 2.
import he from 'he';

export const WP_BASE = (process.env.WP_BASE_URL ?? 'https://www.nexos.com.mx/wp-json/wp/v2').replace(/\/$/, '');

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];
const RE_NUMERO_REVISTA = new RegExp(`^(19|20)\\d{2}\\s+(${MESES.join('|')})$`, 'i');

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Decodifica entidades HTML (&#8211;, &amp;, &#8220;...) y normaliza espacios. */
export function decode(texto: string | null | undefined): string {
  if (!texto) return '';
  return he.decode(texto).replace(/\s+/g, ' ').trim();
}

export function esNumeroRevista(nombreCategoria: string): boolean {
  return RE_NUMERO_REVISTA.test(nombreCategoria.trim());
}

interface ErrorWp extends Error {
  status?: number;
  code?: string;
}

/**
 * GET con reintento y backoff exponencial en 5xx/429. Un 400 se propaga tal
 * cual (rest_post_invalid_page_number es la señal de "terminaste", no un fallo).
 */
export async function fetchJson<T>(url: string, maxRetries = 6): Promise<{ data: T; headers: Headers }> {
  let intento = 0;
  for (;;) {
    const res = await fetch(url);

    if (res.ok) {
      const data = (await res.json()) as T;
      return { data, headers: res.headers };
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

interface CategoriaWp {
  id: number;
  name: string;
}

/** Descarga /wp/v2/categories completo y arma el mapa id -> nombre decodificado. */
export async function construirMapaCategorias(): Promise<Map<number, string>> {
  const mapa = new Map<number, string>();
  for (let page = 1; ; page++) {
    const url = `${WP_BASE}/categories?per_page=100&page=${page}&_fields=id,name`;
    let respuesta;
    try {
      respuesta = await fetchJson<CategoriaWp[]>(url);
    } catch (err) {
      if ((err as ErrorWp).status === 400) break; // rest_post_invalid_page_number
      throw err;
    }
    if (respuesta.data.length === 0) break;
    for (const cat of respuesta.data) mapa.set(cat.id, decode(cat.name));
    await sleep(300);
  }
  return mapa;
}

/**
 * A veces coauthors trae objetos con nombre, a veces IDs numéricos sueltos.
 * Los IDs no se pueden resolver sin /wp/v2/users (401 sin credenciales), así
 * que se ignoran: nunca se inventa un nombre a partir de un ID.
 */
export function resolverAutores(coauthors: unknown): { autores: string[]; confianza: 'wp' | 'ausente' } {
  const nombres = new Set<string>();

  if (Array.isArray(coauthors)) {
    for (const entrada of coauthors) {
      if (typeof entrada === 'string') {
        const nombre = decode(entrada);
        if (nombre) nombres.add(nombre);
      } else if (entrada && typeof entrada === 'object') {
        const obj = entrada as Record<string, unknown>;
        const candidato = obj.display_name ?? obj.name ?? obj.title;
        if (typeof candidato === 'string' && candidato.trim()) nombres.add(decode(candidato));
      }
      // entrada numérica (ID sin resolver): se descarta, no se inventa nombre.
    }
  }

  if (nombres.size === 0) return { autores: [], confianza: 'ausente' };
  return { autores: [...nombres], confianza: 'wp' };
}
