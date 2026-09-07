// Utilidades de texto puras (sin red, sin base de datos): normalización de
// nombres, lectura de años y décadas en la pregunta, y saneado de todo lo que
// devuelve un LLM. Están aisladas aquí para poder probarlas sin datos
// (`deno test supabase/functions/buscar/pruebas.test.ts`).

import { ANIO_MAX, ANIO_MIN } from './config.ts';

/**
 * Normaliza para comparar nombres: sin acentos, minúsculas, sin puntuación.
 * Los nombres de autor de la API de Nexos vienen sin acentos y los reales sí
 * los traen (CLAUDE.md sección 2), así que comparar sin acentos es obligatorio.
 */
export function normalizar(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokens(s: string): string[] {
  return normalizar(s).split(' ').filter((t) => t.length > 0);
}

/** Palabras vacías del español que no aportan al emparejamiento de nombres. */
const VACIAS = new Set([
  'de', 'del', 'la', 'las', 'el', 'los', 'y', 'e', 'en', 'a', 'que', 'sobre',
  'todo', 'toda', 'todos', 'todas', 'lo', 'un', 'una', 'unos', 'unas', 'por',
  'para', 'con', 'se', 'ha', 'han', 'su', 'sus', 'me', 'mi', 'nos', 'al',
  'articulos', 'articulo', 'textos', 'texto', 'nexos', 'revista', 'archivo',
  'publico', 'publicado', 'publicados', 'escrito', 'escribio', 'dame',
  'muestrame', 'lista', 'listado', 'quiero', 'ver', 'busca', 'buscar',
]);

export function esVacia(t: string): boolean {
  return VACIAS.has(t);
}

const DECADAS: Array<{ patron: RegExp; desde: number; hasta: number }> = [
  { patron: /\b(los\s+)?setentas?\b/, desde: 1970, hasta: 1979 },
  { patron: /\b(los\s+)?ochentas?\b/, desde: 1980, hasta: 1989 },
  { patron: /\b(los\s+)?noventas?\b/, desde: 1990, hasta: 1999 },
  { patron: /\b(los\s+)?(dos\s*miles?|2000s)\b/, desde: 2000, hasta: 2009 },
  { patron: /\bdecada\s+de\s+(los\s+)?setenta\b/, desde: 1970, hasta: 1979 },
  { patron: /\bdecada\s+de\s+(los\s+)?ochenta\b/, desde: 1980, hasta: 1989 },
  { patron: /\bdecada\s+de\s+(los\s+)?noventa\b/, desde: 1990, hasta: 1999 },
  { patron: /\b(los|anos)\s+(70|70s)\b/, desde: 1970, hasta: 1979 },
  { patron: /\b(los|anos)\s+(80|80s)\b/, desde: 1980, hasta: 1989 },
  { patron: /\b(los|anos)\s+(90|90s)\b/, desde: 1990, hasta: 1999 },
];

export interface RangoAnios {
  desde: number;
  hasta: number;
}

/** Años sueltos mencionados en la pregunta, acotados al rango real del archivo. */
export function aniosMencionados(pregunta: string): number[] {
  const encontrados = new Set<number>();
  for (const m of pregunta.matchAll(/\b(1[89]\d{2}|20\d{2})\b/g)) {
    const n = Number.parseInt(m[1], 10);
    if (n >= ANIO_MIN && n <= ANIO_MAX) encontrados.add(n);
  }
  return [...encontrados].sort((a, b) => a - b);
}

/**
 * Décadas escritas con palabras ("los noventa", "años 80").
 * Se evalúan sobre el texto normalizado (sin acentos), por eso los patrones
 * de arriba dicen `decada` y `anos`.
 */
export function decadasMencionadas(pregunta: string): RangoAnios[] {
  const texto = normalizar(pregunta);
  const rangos: RangoAnios[] = [];
  for (const d of DECADAS) {
    if (d.patron.test(texto) && !rangos.some((r) => r.desde === d.desde)) {
      rangos.push({ desde: d.desde, hasta: d.hasta });
    }
  }
  return rangos;
}

/**
 * Rango de años de publicación que se deduce de la pregunta.
 * Devuelve null si no hay ninguno: ante la duda NO se acota la publicación
 * (CLAUDE.md sección 4, "Dos nociones de año que NO son lo mismo").
 */
export function rangoPublicacion(pregunta: string): RangoAnios | null {
  const decadas = decadasMencionadas(pregunta);
  const anios = aniosMencionados(pregunta);
  const candidatos: RangoAnios[] = [
    ...decadas,
    ...anios.map((a) => ({ desde: a, hasta: a })),
  ];
  if (candidatos.length === 0) return null;
  return {
    desde: Math.min(...candidatos.map((c) => c.desde)),
    hasta: Math.max(...candidatos.map((c) => c.hasta)),
  };
}

/** Expande un rango a la lista de años (para `anios_referidos && '{...}'`). */
export function expandirRango(r: RangoAnios): number[] {
  const salida: number[] = [];
  for (let a = r.desde; a <= r.hasta && salida.length < 120; a++) salida.push(a);
  return salida;
}

/**
 * Quita de la pregunta lo que ya se convirtió en filtro duro (años, décadas,
 * nombre de autor, muletillas) y deja lo que puede servir como tema.
 */
export function temaResidual(pregunta: string, autores: string[]): string {
  let t = normalizar(pregunta);
  for (const autor of autores) {
    for (const tk of tokens(autor)) t = t.replaceAll(tk, ' ');
  }
  t = t.replace(/\b(1[89]\d{2}|20\d{2})\b/g, ' ');
  for (const d of DECADAS) t = t.replace(d.patron, ' ');
  const palabras = t.split(/\s+/).filter((p) => p.length > 2 && !esVacia(p));
  return palabras.join(' ').trim();
}

/**
 * Todo texto que devuelve un LLM pasa por aquí antes de salir a la UI:
 * sin etiquetas (nunca se renderiza HTML del modelo, CLAUDE.md sección 6),
 * sin caracteres de control, con largo acotado.
 */
export function sanearTextoModelo(s: unknown, maxLargo = 1_200): string {
  if (typeof s !== 'string') return '';
  const limpio = s
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return limpio.length > maxLargo ? `${limpio.slice(0, maxLargo - 1).trimEnd()}…` : limpio;
}

/** Un texto del modelo con URLs es sospechoso: el modelo no escribe ligas. */
export function contieneLiga(s: string): boolean {
  return /https?:\/\//i.test(s) || /www\./i.test(s) || /nexos\.com\.mx/i.test(s);
}

/**
 * Escapa el texto del archivo antes de meterlo en el prompt. El contenido del
 * archivo es DATO, nunca instrucción (CLAUDE.md sección 6): si un título
 * trajera algo que parezca una etiqueta, no debe poder cerrar el bloque.
 */
export function escaparParaPrompt(s: string): string {
  return s.replace(/[<>]/g, (c) => (c === '<' ? '‹' : '›'));
}
