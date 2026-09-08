// Trae el cuerpo de los artículos desde la API de su subdominio.
//
// La ingesta indexa el cuerpo y lo descarta a propósito (CLAUDE.md §6: los
// artículos no viven en esta base), así que el enriquecimiento tiene que
// volver a pedirlo. No se guarda aquí tampoco: se usa para armar el prompt y
// se tira.
//
// Aplica a los 27 sitios, no solo a los subdominios. El spec daba por hecho que
// en www el cuerpo entero está tras el paywall, y medido sobre 1,945 artículos
// no es así: el paywall cubre el archivo impreso (0% de cuerpo público en los
// ochenta, 1% en los noventa, 3% en los dos mil) pero se abre en lo reciente
// (25% en los dosmildiez, 54% en los veinte). Son ~3,475 artículos de www con
// el cuerpo disponible sin credenciales.
//
// Los que sigan cerrados devuelven `content` vacío y se catalogan con su
// metadata, o se saltan con --solo-con-cuerpo.
import './red.js';
import { SITIOS, type Sitio } from './sitios.js';
import { decode, fetchJson, sleep } from './wp.js';

const DELAY_MS = 300;

/**
 * Tope duro de WordPress: `per_page` tiene que estar entre 1 y 100, y pedir más
 * devuelve 400 con `rest_invalid_param`. No es un detalle: con lotes de 150 la
 * petición de cuerpos fallaba entera y el enriquecimiento seguía con metadata
 * sola, produciendo resúmenes vacíos y quemando cuota, sin que nada lo dijera.
 */
const MAX_POR_PETICION = 100;

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

  // Se parte en tandas de 100 antes de pedir nada: pasarse es un 400 seguro.
  if (idsWp.length > MAX_POR_PETICION) {
    for (let i = 0; i < idsWp.length; i += MAX_POR_PETICION) {
      const tanda = await cuerposDeUnSitio(sitio, idsWp.slice(i, i + MAX_POR_PETICION), maxChars);
      for (const [k, v] of tanda) mapa.set(k, v);
      await sleep(DELAY_MS);
    }
    return mapa;
  }

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
      // Sin cuerpo se sigue, pero se dice: un fallo mudo aquí degrada la corrida
      // entera a metadata sin que nadie lo note.
      console.warn(`   ⚠ ${sitio.clave}: no se pudo traer el cuerpo de ${idsWp.length} artículo(s): ${e.message.slice(0, 160)}`);
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
