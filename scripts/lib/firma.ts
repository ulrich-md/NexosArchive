// Extracción de la firma desde el HTML del artículo.
//
// Vive aparte del script que la usa para poder importarla sin ejecutar la
// recuperación completa: `recuperar-autores.ts` corre su main() al importarse.
import { decode } from './wp.js';

/** Firmas que no son personas: usuarios del CMS o la firma institucional. */
export const FIRMAS_NO_PERSONA = new Set(['4dm1n', 'nexos', 'Nexos', 'N/A', 'n/a', '']);

/**
 * Saca la firma del HTML del artículo. Devuelve [] si la página no la trae,
 * si dice "N/A" o si el campo se usó para otra cosa: sin nombre no hay autor,
 * y nunca se rellena el hueco (CLAUDE.md §7).
 */
export function autorDesdePagina(html: string): string[] {
  const m = html.match(/<div class="el-autor">([\s\S]*?)<\/div>/i);
  if (!m) return [];

  // El marcado trae un paréntesis de afiliación que suele venir vacío:
  // "Ulises Beltrán  (  )". Se quita cuando no tiene contenido real.
  const texto = decode(m[1]).replace(/\(\s*\)\s*$/, '').trim();
  if (!texto) return [];

  // En las reseñas, Nexos a veces usa este campo para la ficha del libro
  // reseñado en vez de para la firma. Ejemplo real (id 11349):
  //   "Jorge Montaño: Misión en Washington, 1993-1995, Planeta, México, 2004, 305 pp."
  // Partir eso por comas produce "autores" llamados "1993-1995" y "305 pp.".
  // Un año o una paginación nunca aparecen en una firma, así que si están, esto
  // no es una firma: se descarta entero. Mejor sin autor que con basura.
  if (/\b(19|20)\d{2}\b/.test(texto) || /\bpp?\./i.test(texto)) return [];

  // Varias firmas pueden venir separadas por " y " o por coma. Las mesas
  // redondas de Nexos llegan a traer siete firmas legítimas, así que no se
  // limita la cantidad: se filtra por la forma de cada una.
  return [
    ...new Set(
      texto
        .split(/\s+y\s+|,(?![^(]*\))/i)
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
