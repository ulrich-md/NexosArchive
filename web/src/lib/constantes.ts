import type { Modo } from './contrato';

/**
 * Cifras verificadas contra la ingesta reconciliada de los 27 WordPress de
 * Nexos (CLAUDE.md secciones 1 y 2). No son datos de ejemplo: el subtítulo solo
 * las usa mientras `facetas` no haya respondido, y en cuanto el backend reporta
 * un total real, manda el real — decir una cifra redonda con la base a medias
 * sería repetir la mentira de la versión de Lovable.
 *
 * 32,942 es el total tras deduplicar, no los 33,624 artículos remotos: los
 * subdominios republican 681 textos que ya están en el sitio principal, y
 * contarlos dos veces le prometería al editor 681 artículos que no existen.
 */
export const ANIO_INICIAL = 1978;
export const ANIO_FINAL = 2026;
export const TOTAL_ESPERADO = 32942;

export const LINEA_AYUDA = `Solo responde con lo que existe en el archivo de la revista, ${ANIO_INICIAL}–${ANIO_FINAL}`;

export const DIAS_RETENCION = 7;

/** Chips de la sección 3, mejora 4. `Buscar` es el carril híbrido de la sección 4. */
export const MODOS: ReadonlyArray<{ id: Modo; etiqueta: string; ayuda: string }> = [
  {
    id: 'panorama',
    etiqueta: 'Panorama',
    ayuda: 'Agrupa cientos de textos en temáticas y redacta una síntesis.',
  },
  {
    id: 'hibrida',
    etiqueta: 'Buscar',
    ayuda: 'Búsqueda por significado y por texto, fusionadas y reordenadas.',
  },
  {
    id: 'catalogo',
    etiqueta: 'Catálogo',
    ayuda: 'Lista directa desde la base, sin modelo de lenguaje.',
  },
];

/** Sección 3, mejora 6. Texto exacto. */
export const EJEMPLOS: readonly string[] = [
  '¿Qué se ha escrito en Nexos sobre el 2006?',
  'Artículos de 1988 sobre fraude electoral',
  'Todo lo que publicó Ángeles Mastretta en los noventa',
];

/** Pestañas del sidebar. */
export const PESTANAS = [
  { id: 'autores', etiqueta: 'Autores' },
  { id: 'secciones', etiqueta: 'Secciones' },
  { id: 'decadas', etiqueta: 'Décadas' },
] as const;

export type PestanaId = (typeof PESTANAS)[number]['id'];
