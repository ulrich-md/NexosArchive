// Carril `catalogo` (CLAUDE.md sección 4).
//
// "Es una consulta SQL, no una pregunta. CERO LLM. Debe responder en < 100 ms."
// Todo lo que hay aquí es un WHERE con índice y una página de resultados.
// Si algo de este archivo llama a un modelo, está mal.

import { CATALOGO_POR_PAGINA, CATALOGO_POR_PAGINA_MAX } from '../config.ts';
import { bd } from '../bd.ts';
import { armarFichas } from '../fichas.ts';
import {
  aproximar,
  buscarArticulos,
  describirFiltros,
  hayFiltros,
  literalArreglo,
  type FiltrosConsulta,
  type ResultadoCarril,
} from './comun.ts';
import type { Aviso, PasoTraza, Sintesis } from '../tipos.ts';

export interface OpcionesCatalogo {
  pagina: number;
  por_pagina: number;
}

export function normalizarPaginacion(op: Partial<OpcionesCatalogo>): OpcionesCatalogo {
  const pagina = Number.isInteger(op.pagina) && op.pagina! > 0 ? op.pagina! : 1;
  const bruto = Number.isInteger(op.por_pagina) && op.por_pagina! > 0
    ? op.por_pagina!
    : CATALOGO_POR_PAGINA;
  return { pagina, por_pagina: Math.min(bruto, CATALOGO_POR_PAGINA_MAX) };
}

/**
 * El resumen que ve el editor sobre CUALQUIER pregunta, no solo panorama
 * (petición explícita: "el resumen varía de acuerdo a la pregunta"). Catálogo
 * sigue en CERO LLM (CLAUDE.md sección 4): esto es aritmética sobre los
 * resultados reales, no redacción. Dos consultas más, ambas por el índice de
 * `anio_pub`, así que el carril se sigue quedando muy por debajo de 100 ms.
 */
async function resumenCalculado(
  filtros: FiltrosConsulta,
  total: number,
): Promise<Sintesis | null> {
  if (total === 0) return null;

  const anioExtremo = async (asc: boolean): Promise<number | null> => {
    let q = bd().from('articulos').select('anio_pub');
    if (filtros.autores.length > 0) q = q.filter('autores', 'ov', literalArreglo(filtros.autores));
    if (filtros.rango_pub) q = q.gte('anio_pub', filtros.rango_pub.desde).lte('anio_pub', filtros.rango_pub.hasta);
    if (filtros.anios_referidos.length > 0) {
      q = q.filter('anios_referidos', 'ov', literalArreglo(filtros.anios_referidos));
    }
    if (filtros.temas.length > 0) q = q.filter('temas', 'ov', literalArreglo(filtros.temas));
    if (filtros.texto && filtros.texto.trim() !== '') {
      q = q.textSearch('ts', filtros.texto.trim(), { config: 'spanish', type: 'websearch' });
    }
    if (filtros.seccion) q = q.eq('seccion', filtros.seccion);
    const { data, error } = await q.order('anio_pub', { ascending: asc }).limit(1).maybeSingle();
    if (error) return null; // el resumen es una cortesía: si falla, no tumba la respuesta
    return (data as { anio_pub: number } | null)?.anio_pub ?? null;
  };

  const [anioMin, anioMax] = await Promise.all([anioExtremo(true), anioExtremo(false)]);

  const cifra = total === 1 ? '1 artículo' : `${total} artículos`;
  const rango = anioMin != null && anioMax != null
    ? anioMin === anioMax ? ` de ${anioMin}` : ` entre ${anioMin} y ${anioMax}`
    : '';

  return {
    texto: `${cifra}${rango} que cumplen: ${describirFiltros(filtros)}.`,
    temas: [],
    fichas_consideradas: total,
    modelo: 'calculado',
  };
}

export async function carrilCatalogo(
  filtros: FiltrosConsulta,
  op: OpcionesCatalogo,
  avisosPrevios: Aviso[] = [],
): Promise<ResultadoCarril> {
  const t0 = performance.now();
  const desde = (op.pagina - 1) * op.por_pagina;

  const { filas, total } = await buscarArticulos(filtros, {
    desde,
    limite: op.por_pagina,
  });

  const paso = {
    paso: 'sql' as const,
    titulo: 'Consultó el archivo',
    detalle: `${describirFiltros(filtros)} · ${total} coincidencias · página ${op.pagina}`,
    ms: Math.round(performance.now() - t0),
  };

  if (filas.length === 0) {
    // Nunca una respuesta vacía (sección 7, regla 3). Si ni siquiera había
    // filtros, no hay nada que relajar: eso significa archivo vacío y lo
    // resuelve el llamador con ARCHIVO_VACIO.
    if (!hayFiltros(filtros)) {
      return {
        modo: 'catalogo',
        fichas: [],
        total: 0,
        pagina: op.pagina,
        por_pagina: op.por_pagina,
        aproximados: false,
        reformulacion: null,
        sintesis: null,
        filtros,
        avisos: avisosPrevios,
        pasos: [paso],
      };
    }

    // Una página vacía más allá de la primera no es "sin resultados": es que
    // se acabó la lista. Se dice así, sin aproximar.
    if (desde > 0 && total > 0) {
      return {
        modo: 'catalogo',
        fichas: [],
        total,
        pagina: op.pagina,
        por_pagina: op.por_pagina,
        aproximados: false,
        reformulacion: `Ya no hay más resultados: son ${total} en total.`,
        sintesis: null,
        filtros,
        avisos: avisosPrevios,
        pasos: [paso],
      };
    }

    const aprox = await aproximar(filtros);
    return {
      modo: 'catalogo',
      fichas: aprox.fichas,
      total: aprox.fichas.length,
      pagina: 1,
      por_pagina: op.por_pagina,
      aproximados: true,
      reformulacion: aprox.reformulacion,
      sintesis: null,
      filtros,
      avisos: avisosPrevios,
      pasos: [paso, aprox.paso],
    };
  }

  const t1 = performance.now();
  const sintesis = await resumenCalculado(filtros, total);
  const pasos: PasoTraza[] = [paso];
  if (sintesis) {
    pasos.push({
      paso: 'sintesis',
      titulo: 'Calculó el resumen',
      detalle: 'Sin modelo: aritmética directa sobre los resultados.',
      ms: Math.round(performance.now() - t1),
    });
  }

  return {
    modo: 'catalogo',
    fichas: armarFichas(filas),
    total,
    pagina: op.pagina,
    por_pagina: op.por_pagina,
    aproximados: false,
    reformulacion: null,
    sintesis,
    filtros,
    avisos: avisosPrevios,
    pasos,
  };
}
