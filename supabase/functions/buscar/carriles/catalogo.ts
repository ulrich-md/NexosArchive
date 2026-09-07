// Carril `catalogo` (CLAUDE.md sección 4).
//
// "Es una consulta SQL, no una pregunta. CERO LLM. Debe responder en < 100 ms."
// Todo lo que hay aquí es un WHERE con índice y una página de resultados.
// Si algo de este archivo llama a un modelo, está mal.

import { CATALOGO_POR_PAGINA, CATALOGO_POR_PAGINA_MAX } from '../config.ts';
import { armarFichas } from '../fichas.ts';
import {
  aproximar,
  buscarArticulos,
  describirFiltros,
  hayFiltros,
  type FiltrosConsulta,
  type ResultadoCarril,
} from './comun.ts';
import type { Aviso } from '../tipos.ts';

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

  return {
    modo: 'catalogo',
    fichas: armarFichas(filas),
    total,
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
