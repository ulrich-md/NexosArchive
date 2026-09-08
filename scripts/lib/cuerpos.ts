// Trae el cuerpo de los artículos desde la API de su subdominio.
//
// La ingesta indexa el cuerpo y lo descarta a propósito (CLAUDE.md §6: los
// artículos no viven en esta base), así que el enriquecimiento tiene que
// volver a pedirlo. No se guarda aquí tampoco: se usa para armar el prompt y
// se tira.
//
// Solo aplica a los 26 subdominios. En www el cuerpo está tras el paywall y
// `content.rendered` viene vacío, así que pedirlo sería gastar peticiones para
// nada.
import './red.js';
import { SITIOS, type Sitio } from './sitios.js';
import { decode, fetchJson, sleep } from './wp.js';

const DELAY_MS = 300;

const POR_CLAVE = new Map(SITIOS.map((s) => [s.clave, s]));

export interface ArticuloConCuerpo {
  id: number;
  sitio: string;
  id_wp: number;
}

interface ErrorWp extends Error {
  status?: number;
  jsonInvalido?: boolean;
}

function urlApi(sitio: Sitio): string {
  const host = sitio.clave === 'www' ? 'www.nexos.com.mx' : `${sitio.clave}.nexos.com.mx`;
  return `https://${host}/wp-json/wp/v2`;
}

/**
 * Un lote de cuerpos de un mismo sitio, en una sola petición (`include=`).
 *
 * Si el servidor devuelve JSON inválido —pasa, ver CLAUDE.md §2— se parte la
 * lista a la mitad hasta aislar al artículo culpable, que se queda sin cuerpo.
 * Perder un cuerpo cuesta un resumen peor; perder el lote cuesta veinte.
 */
async function cuerposDeUnSitio(
  sitio: Sitio,
  idsWp: number[],
  maxChars: number,
): Promise<Map<number, string>> {
  const mapa = new Map<number, string>();
  if (idsWp.length === 0) return mapa;

  const url =
    `${urlApi(sitio)}/posts?include=${idsWp.join(',')}&per_page=${idsWp.length}&_fields=id,content`;

  try {
    const { data } = await fetchJson<{ id: number; content?: { rendered?: string } }[]>(url);
    for (const post of data) {
      const texto = decode(post.content?.rendered ?? '');
      if (texto) mapa.set(post.id, texto.slice(0, maxChars));
    }
    return mapa;
  } catch (err) {
    const e = err as ErrorWp;
    if (!e.jsonInvalido || idsWp.length === 1) {
      // Sin cuerpo se sigue: el artículo se cataloga con su metadata y ya.
      return mapa;
    }
    const mitad = Math.ceil(idsWp.length / 2);
    await sleep(DELAY_MS);
    const a = await cuerposDeUnSitio(sitio, idsWp.slice(0, mitad), maxChars);
    await sleep(DELAY_MS);
    const b = await cuerposDeUnSitio(sitio, idsWp.slice(mitad), maxChars);
    return new Map([...a, ...b]);
  }
}

/**
 * Cuerpos de un lote mezclado, agrupando por sitio. Devuelve un mapa por el id
 * de la base (no por el de WordPress, que se repite entre sitios).
 */
export async function traerCuerpos(
  articulos: ArticuloConCuerpo[],
  maxChars: number,
): Promise<Map<number, string>> {
  const porSitio = new Map<string, ArticuloConCuerpo[]>();
  for (const a of articulos) {
    if (a.sitio === 'www') continue; // paywall: content viene vacío
    const lista = porSitio.get(a.sitio) ?? [];
    lista.push(a);
    porSitio.set(a.sitio, lista);
  }

  const salida = new Map<number, string>();
  for (const [clave, lista] of porSitio) {
    const sitio = POR_CLAVE.get(clave);
    if (!sitio) continue;
    const porIdWp = await cuerposDeUnSitio(sitio, lista.map((a) => a.id_wp), maxChars);
    for (const a of lista) {
      const cuerpo = porIdWp.get(a.id_wp);
      if (cuerpo) salida.set(a.id, cuerpo);
    }
    await sleep(DELAY_MS);
  }
  return salida;
}
