// Piezas compartidas por los tres carriles: construcción de la consulta SQL,
// descripción de los filtros para el copy, y la regla de "nunca una respuesta
// vacía" (CLAUDE.md sección 7, regla 3).

import { bd } from '../bd.ts';
import { errorBd } from '../errores.ts';
import { APROXIMADOS_N } from '../config.ts';
import { armarFichas } from '../fichas.ts';
import type { RangoAnios } from '../texto.ts';
import {
  COLUMNAS_ARTICULO,
  type Aviso,
  type Ficha,
  type FilaArticulo,
  type FiltrosAplicados,
  type Modo,
  type PasoTraza,
  type Sintesis,
} from '../tipos.ts';

export interface FiltrosConsulta {
  autores: string[];
  rango_pub: RangoAnios | null;
  anios_referidos: number[];
  temas: string[];
  texto: string | null;
  seccion: string | null;
}

export function filtrosVacios(): FiltrosConsulta {
  return { autores: [], rango_pub: null, anios_referidos: [], temas: [], texto: null, seccion: null };
}

export function aFiltrosAplicados(f: FiltrosConsulta): FiltrosAplicados {
  return {
    autores: f.autores,
    anios_pub: f.rango_pub ? { desde: f.rango_pub.desde, hasta: f.rango_pub.hasta } : null,
    anios_referidos: f.anios_referidos,
    temas: f.temas,
    texto: f.texto,
    seccion: f.seccion,
  };
}

export function hayFiltros(f: FiltrosConsulta): boolean {
  return f.autores.length > 0 || f.rango_pub !== null || f.anios_referidos.length > 0 ||
    f.temas.length > 0 || (f.texto !== null && f.texto !== '') || f.seccion !== null;
}

/**
 * Literal de arreglo de Postgres con comillas por elemento. postgrest-js une
 * con comas sin escapar, y un nombre con coma rompería el filtro en silencio.
 */
export function literalArreglo(valores: Array<string | number>): string {
  const partes = valores.map((v) =>
    typeof v === 'number' ? String(v) : `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  );
  return `{${partes.join(',')}}`;
}

export interface OpcionesBusqueda {
  desde?: number;
  limite: number;
  conTotal?: boolean;
}

export interface ResultadoBusqueda {
  filas: FilaArticulo[];
  total: number;
}

/**
 * La consulta del archivo. Toda lectura pasa por aquí, con service role y
 * siempre paginada: nunca se traen miles de filas al cliente (ese fue uno de
 * los bugs de la versión anterior, CLAUDE.md sección 0).
 */
export async function buscarArticulos(
  f: FiltrosConsulta,
  op: OpcionesBusqueda,
): Promise<ResultadoBusqueda> {
  const desde = op.desde ?? 0;
  let q = bd()
    .from('articulos')
    .select(COLUMNAS_ARTICULO, { count: op.conTotal === false ? undefined : 'exact' });

  if (f.autores.length > 0) q = q.filter('autores', 'ov', literalArreglo(f.autores));
  if (f.rango_pub) {
    q = q.gte('anio_pub', f.rango_pub.desde).lte('anio_pub', f.rango_pub.hasta);
  }
  if (f.anios_referidos.length > 0) {
    q = q.filter('anios_referidos', 'ov', literalArreglo(f.anios_referidos));
  }
  if (f.temas.length > 0) q = q.filter('temas', 'ov', literalArreglo(f.temas));
  if (f.texto && f.texto.trim() !== '') {
    q = q.textSearch('ts', f.texto.trim(), { config: 'spanish', type: 'websearch' });
  }
  if (f.seccion) q = q.eq('seccion', f.seccion);

  const { data, error, count } = await q
    .order('fecha_pub', { ascending: false })
    .order('id', { ascending: false })
    .range(desde, desde + op.limite - 1);

  if (error) throw errorBd('búsqueda en articulos', error);

  return {
    filas: (data ?? []) as unknown as FilaArticulo[],
    total: count ?? (data?.length ?? 0),
  };
}

/** Descripción en español de los filtros, para el copy y la traza. */
export function describirFiltros(f: FiltrosConsulta): string {
  const partes: string[] = [];
  if (f.autores.length > 0) partes.push(`autor: ${f.autores.join(', ')}`);
  if (f.rango_pub) {
    partes.push(
      f.rango_pub.desde === f.rango_pub.hasta
        ? `publicado en ${f.rango_pub.desde}`
        : `publicado entre ${f.rango_pub.desde} y ${f.rango_pub.hasta}`,
    );
  }
  if (f.anios_referidos.length > 0) {
    const a = f.anios_referidos;
    partes.push(
      a.length === 1 ? `habla del ${a[0]}` : `habla de ${a[0]}–${a[a.length - 1]}`,
    );
  }
  if (f.temas.length > 0) partes.push(`temas: ${f.temas.join(', ')}`);
  if (f.texto) partes.push(`texto: «${f.texto}»`);
  if (f.seccion) partes.push(`sección: ${f.seccion}`);
  return partes.length > 0 ? partes.join(' · ') : 'sin filtros';
}

export interface Aproximacion {
  fichas: Ficha[];
  reformulacion: string;
  filtros: FiltrosConsulta;
  paso: PasoTraza;
}

/**
 * Nunca una respuesta vacía: si los filtros exactos no dan nada, se relajan en
 * orden (tema → años → autor) y se devuelven los más próximos marcados como
 * aproximados, con una reformulación concreta construida con los filtros
 * REALES (nada inventado).
 */
export async function aproximar(f: FiltrosConsulta): Promise<Aproximacion> {
  const t0 = performance.now();
  const intentos: Array<{ filtros: FiltrosConsulta; quitado: string }> = [];

  if (f.texto || f.temas.length > 0) {
    intentos.push({
      filtros: { ...f, texto: null, temas: [] },
      quitado: 'el tema',
    });
  }
  if (f.anios_referidos.length > 0 || f.rango_pub) {
    intentos.push({
      filtros: { ...f, texto: null, temas: [], anios_referidos: [], rango_pub: null },
      quitado: 'el tema y la acotación por año',
    });
  }
  if (f.autores.length > 0) {
    intentos.push({
      filtros: { ...filtrosVacios(), autores: f.autores },
      quitado: 'todo menos el autor',
    });
  }
  // Último recurso: lo más reciente del archivo.
  intentos.push({ filtros: filtrosVacios(), quitado: 'todos los filtros' });

  for (const intento of intentos) {
    const { filas } = await buscarArticulos(intento.filtros, {
      limite: APROXIMADOS_N,
      conTotal: false,
    });
    if (filas.length > 0) {
      const reformulacion = construirReformulacion(f, intento.quitado);
      return {
        fichas: armarFichas(filas),
        reformulacion,
        filtros: intento.filtros,
        paso: {
          paso: 'aproximacion',
          titulo: 'No hubo coincidencias exactas',
          detalle: `Se relajó ${intento.quitado}. Filtros originales: ${describirFiltros(f)}.`,
          ms: Math.round(performance.now() - t0),
        },
      };
    }
  }

  return {
    fichas: [],
    reformulacion: construirReformulacion(f, 'todos los filtros'),
    filtros: filtrosVacios(),
    paso: {
      paso: 'aproximacion',
      titulo: 'No hubo coincidencias',
      detalle: 'Ni relajando todos los filtros hubo resultados.',
      ms: Math.round(performance.now() - t0),
    },
  };
}

function construirReformulacion(f: FiltrosConsulta, quitado: string): string {
  const sugerencias: string[] = [];
  if (f.texto) sugerencias.push(`«${f.texto}» sin acotar el año`);
  if (f.rango_pub) {
    sugerencias.push(
      f.rango_pub.desde === f.rango_pub.hasta
        ? `todo lo de ${f.rango_pub.desde}`
        : `todo lo de ${f.rango_pub.desde}–${f.rango_pub.hasta}`,
    );
  }
  if (f.autores.length > 0) sugerencias.push(`todo lo de ${f.autores[0]}`);

  const base = `No hay textos que cumplan a la vez ${describirFiltros(f)}. ` +
    `Se muestran los más próximos (se relajó ${quitado}).`;
  return sugerencias.length > 0 ? `${base} Prueba con: ${sugerencias.join(', o ')}.` : base;
}

/** Lo que devuelve cualquier carril. */
export interface ResultadoCarril {
  modo: Modo;
  fichas: Ficha[];
  total: number;
  pagina: number;
  por_pagina: number;
  aproximados: boolean;
  reformulacion: string | null;
  sintesis: Sintesis | null;
  filtros: FiltrosConsulta;
  avisos: Aviso[];
  pasos: PasoTraza[];
}
