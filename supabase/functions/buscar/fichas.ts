// Armado de fichas. Este es el punto donde se cumple la regla 1 de la sección 7
// de CLAUDE.md: el modelo devuelve ids, la aplicación arma la ficha desde la
// base de datos. Ningún campo de una ficha proviene de un LLM.

import type { Ficha, FilaArticulo } from './tipos.ts';

/** Literal exacto que pide CLAUDE.md sección 7, regla 2. */
export const SIN_AUTOR = 'autor no consignado';

export function armarFicha(fila: FilaArticulo): Ficha {
  const autores = (fila.autores ?? [])
    .filter((a): a is string => typeof a === 'string' && a.trim() !== '')
    .map((a) => a.trim());

  return {
    id: fila.id,
    titulo: fila.titulo,
    url: fila.url,
    autores,
    // Sin autor ⇒ literal `autor no consignado`. Jamás se deduce del estilo,
    // del tema ni del año.
    autor_etiqueta: autores.length > 0 ? autores.join(' · ') : SIN_AUTOR,
    autor_consignado: autores.length > 0,
    autor_confianza: fila.autor_confianza ?? 'ausente',
    fecha_pub: fila.fecha_pub,
    anio_pub: fila.anio_pub ?? null,
    numero: fila.numero ?? null,
    seccion: fila.seccion ?? null,
    resumen_linea: fila.resumen_linea ?? null,
  };
}

export function armarFichas(filas: FilaArticulo[]): Ficha[] {
  return filas.map(armarFicha);
}

/**
 * Filtra los ids que devolvió un LLM contra los que de verdad existen.
 * Un id que no está en la base se descarta sin ceremonia (sección 7, regla 1).
 */
export function idsValidos(ids: unknown, existentes: Set<number>): number[] {
  if (!Array.isArray(ids)) return [];
  const vistos = new Set<number>();
  const salida: number[] = [];
  for (const bruto of ids) {
    const n = typeof bruto === 'number' ? bruto : Number.parseInt(String(bruto), 10);
    if (!Number.isInteger(n) || !existentes.has(n) || vistos.has(n)) continue;
    vistos.add(n);
    salida.push(n);
  }
  return salida;
}
