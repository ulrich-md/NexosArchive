// Extracción de la firma desde el HTML del artículo.
//
// Vive aparte del script que la usa para poder importarla sin ejecutar la
// recuperación completa: `recuperar-autores.ts` corre su main() al importarse.
//
// Los 27 WordPress de Nexos firman de tres maneras distintas (reconocido el
// 2026-09-08 sobre los 26 subdominios). Se prueban en este orden:
//
//  1. Enlaces `/author/{slug}/` dentro de `.el-autor`. Es la forma más común en
//     los blogs temáticos. Hay que leer cada <a> por separado: el tema une dos
//     firmas con " and " —en inglés— y decodificar el bloque entero produciría
//     un autor inexistente llamado "Sofia Marquez and Cultura Nexos".
//  2. Texto plano dentro de `.el-autor`, sin enlaces. Es lo de www y lo de los
//     blogs personales (angelesmastretta, aguilarcamin, ...).
//  3. `<span class="el--autor-header-nexos">` dentro del h1. Es lo de
//     poemas.nexos.com.mx, donde `.el-autor` viene VACÍO: sin este caso, los
//     996 poemas del archivo quedarían sin autor.
import { decode } from './wp.js';

/** Firmas que no son personas: usuarios del CMS o la firma institucional. */
export const FIRMAS_NO_PERSONA = new Set(['4dm1n', 'nexos', 'Nexos', 'N/A', 'n/a', '']);

export interface Ancla {
  slug: string;
  nombre: string;
}

const RE_BLOQUE = /<div class="el-autor">([\s\S]*?)<\/div>/i;
const RE_ANCLA = /<a\s[^>]*href="[^"]*\/author\/([^/"]+)\/?"[^>]*>([\s\S]*?)<\/a>/gi;
const RE_SPAN_H1 = /<span class="el--autor-header-nexos">([\s\S]*?)<\/span>/i;

/** Las firmas enlazadas del bloque, con su slug. [] si el bloque no trae enlaces. */
export function anclasDeFirma(html: string): Ancla[] {
  const bloque = html.match(RE_BLOQUE);
  if (!bloque) return [];
  const salida: Ancla[] = [];
  for (const m of bloque[1].matchAll(RE_ANCLA)) {
    const nombre = decode(m[2]);
    if (nombre) salida.push({ slug: m[1], nombre });
  }
  return salida;
}

/**
 * ¿Este texto es una ficha bibliográfica en vez de una firma?
 *
 * En las reseñas, Nexos a veces usa el campo del autor para la ficha del libro
 * reseñado. Ejemplo real (id 11349):
 *   "Jorge Montaño: Misión en Washington, 1993-1995, Planeta, México, 2004, 305 pp."
 * Partir eso por comas produce "autores" llamados "1993-1995" y "305 pp.".
 * Un año o una paginación nunca aparecen en una firma.
 */
function esFichaDeLibro(texto: string): boolean {
  return /\b(19|20)\d{2}\b/.test(texto) || /\bpp?\./i.test(texto);
}

/**
 * Parte un bloque de firma en los nombres que contiene.
 *
 * Separadores: " y ", " and " y la coma. El inglés no es un descuido: Nexos
 * republica piezas traducidas del NYT y del Financial Times conservando la
 * firma original, y sin él quedan autores inexistentes como "By Edward Wong and
 * Mark Landler" o "Sheryl Gay Stolberg and Helene Cooper". El "By" inicial
 * viene de esas mismas firmas y se quita.
 *
 * Se exporta para poder reparar filas ya guardadas sin repetir la lógica.
 */
export function separarFirmas(texto: string): string[] {
  if (!texto || esFichaDeLibro(texto)) return [];
  // Las mesas redondas de Nexos llegan a traer siete firmas legítimas, así que
  // no se limita la cantidad: se filtra por la forma de cada una.
  return [
    ...new Set(
      texto
        .replace(/^\s*(by|por)\s+/i, '')
        .split(/\s+y\s+|\s+and\s+|,(?![^(]*\))/i)
        .map((p) => p.trim())
        .filter(
          (p) =>
            p &&
            !FIRMAS_NO_PERSONA.has(p) &&
            p.length > 2 &&
            p.length < 120 &&
            !/^\d/.test(p) &&   // "305 pp.", "2004"
            !p.includes(':'),   // "Autor: Título del libro"
        ),
    ),
  ];
}

/**
 * Saca la firma del HTML del artículo. Devuelve [] si la página no la trae,
 * si dice "N/A" o si el campo se usó para otra cosa: sin nombre no hay autor,
 * y nunca se rellena el hueco (CLAUDE.md §7).
 *
 * `institucionales` son los slugs de la cuenta del propio blog —"Cultura
 * Nexos", "Juego de La Nueva Suprema Corte"— que el tema cuelga junto al autor
 * real. Los calcula `npm run firmas-sitio`; sin ese archivo la extracción
 * funciona igual, solo que esas cuentas entrarían como si fueran personas.
 */
export function autorDesdePagina(html: string, institucionales?: Set<string>): string[] {
  const anclas = anclasDeFirma(html);
  if (anclas.length > 0) {
    const nombres = anclas
      .filter((a) => !institucionales?.has(a.slug))
      .map((a) => a.nombre)
      .filter((n) => !FIRMAS_NO_PERSONA.has(n) && n.length > 2 && n.length < 120);
    return [...new Set(nombres)];
  }

  const bloque = html.match(RE_BLOQUE);
  if (bloque) {
    // El marcado trae un paréntesis de afiliación que suele venir vacío:
    // "Ulises Beltrán  (  )". Se quita cuando no tiene contenido real.
    const texto = decode(bloque[1]).replace(/\(\s*\)\s*$/, '').trim();
    if (texto) return separarFirmas(texto);
  }

  // poemas.nexos.com.mx: la firma vive en el h1 y `.el-autor` está vacío.
  const span = html.match(RE_SPAN_H1);
  if (span) {
    const texto = decode(span[1]).trim();
    // "Anónimo" se conserva: es como el archivo atribuye el poema, no un hueco
    // que estemos rellenando.
    if (texto) return separarFirmas(texto);
  }

  return [];
}
