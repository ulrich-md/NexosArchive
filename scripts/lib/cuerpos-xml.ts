// Cuerpos leídos de las exportaciones WXR de WordPress.
//
// Por qué existen: el paywall de nexos.com.mx NO borra el artículo, lo tapa al
// mostrarlo — el plugin de membresía sustituye `entry-content` por el anuncio de
// suscripción. El texto sigue en `wp_posts`, y la exportación de WordPress lee
// la base directo, sin pasar por ese filtro. Verificado sobre enero–mayo de 1978:
// 272 entradas, las 272 con su cuerpo.
//
// Así que para los ~16,000 artículos del archivo impreso la fuente no es la API
// —que los devuelve vacíos— sino los XML que exporta quien administra el sitio.
//
// El texto NO se guarda en ningún lado: se arma el mapa en memoria, alimenta el
// prompt y muere con el proceso. Los XML viven en `datos/exports/`, que está en
// .gitignore.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decode } from './wp.js';

export const DIR_EXPORTS = 'datos/exports';

const RE_ITEM = /<item>([\s\S]*?)<\/item>/g;
const RE_ID = /<wp:post_id>(\d+)<\/wp:post_id>/;
const RE_TIPO = /<wp:post_type><!\[CDATA\[(.*?)\]\]><\/wp:post_type>/;
const RE_CUERPO = /<content:encoded><!\[CDATA\[([\s\S]*?)\]\]><\/content:encoded>/;

/**
 * Mapa id_wp -> texto plano, leyendo todos los .xml del directorio.
 *
 * Solo toma `post_type=post`: una exportación de "Todo el contenido" trae
 * además adjuntos y páginas, que no son artículos del archivo.
 */
export function cargarCuerposXml(dir = DIR_EXPORTS, maxChars = 3000): Map<number, string> {
  const mapa = new Map<number, string>();
  if (!existsSync(dir)) return mapa;

  for (const archivo of readdirSync(dir).filter((f) => f.endsWith('.xml'))) {
    const xml = readFileSync(join(dir, archivo), 'utf8');
    for (const m of xml.matchAll(RE_ITEM)) {
      const item = m[1];
      if (RE_TIPO.exec(item)?.[1] !== 'post') continue;
      const id = Number(RE_ID.exec(item)?.[1]);
      if (!Number.isInteger(id) || id <= 0) continue;
      const crudo = RE_CUERPO.exec(item)?.[1];
      if (!crudo) continue;
      const texto = decode(crudo).slice(0, maxChars);
      // Se queda el más largo: un artículo puede venir en dos exportaciones y
      // una de ellas estar recortada.
      if (texto.length > (mapa.get(id)?.length ?? 0)) mapa.set(id, texto);
    }
  }
  return mapa;
}
