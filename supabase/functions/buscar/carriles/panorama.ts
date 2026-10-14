// Carril `panorama` (CLAUDE.md sección 4).
//
// No busca fragmentos: trae 200–400 filas de metadata por SQL y hace UN SOLO
// llamado al LLM que las agrupa en 3–6 temáticas y redacta la síntesis.
//
// Dos cosas que este archivo NO hace, por diseño:
//   - No acota por `anio_pub` cuando la pregunta habla de una época: usa
//     `anios_referidos`. Filtrar por publicación se comería justo los textos
//     que el editor quiere (sección 4, "Dos nociones de año que NO son lo mismo").
//   - No inventa un resumen cuando `resumen_linea` está vacío. El
//     enriquecimiento (paso 3 del orden de trabajo) todavía no corre: mientras
//     no corra, este carril degrada y LO DICE, con aviso y traza.

import { PANORAMA_MAX_FILAS, PANORAMA_MIN_FILAS } from '../config.ts';
import { bd } from '../bd.ts';
import { errorBd, ErrorBuscar } from '../errores.ts';
import { armarFichas } from '../fichas.ts';
import { hayModelo } from '../llm.ts';
import { redactar } from './redaccion.ts';
import { buscarPorSignificado, hayTema } from './significado.ts';
import {
  aproximar,
  buscarArticulos,
  describirFiltros,
  hayFiltros,
  type FiltrosConsulta,
  type ResultadoCarril,
} from './comun.ts';
import type { Aviso, Ficha, FilaArticulo, PasoTraza, Sintesis } from '../tipos.ts';

/** Candidatos por significado para un panorama: de sobra para 3–6 temáticas. */
const PANORAMA_POR_SIGNIFICADO = 250;

// --- ¿Ya corrió el enriquecimiento? -----------------------------------------

interface CacheEnriquecimiento {
  cargado_en: number;
  disponible: boolean;
}
let cacheEnriquecimiento: CacheEnriquecimiento | null = null;
const TTL_ENRIQUECIMIENTO_MS = 5 * 60 * 1000;

/**
 * Sondea si hay al menos un artículo con `resumen_linea`. Es la diferencia
 * entre "el panorama funciona" y "el panorama va con lo que hay": nunca se
 * finge lo segundo.
 */
export async function enriquecimientoDisponible(): Promise<boolean> {
  const ahora = Date.now();
  if (cacheEnriquecimiento && ahora - cacheEnriquecimiento.cargado_en < TTL_ENRIQUECIMIENTO_MS) {
    return cacheEnriquecimiento.disponible;
  }
  const { data, error } = await bd()
    .from('articulos')
    .select('id')
    .not('resumen_linea', 'is', null)
    .limit(1);
  if (error) throw errorBd('sondeo de resumen_linea', error);
  const disponible = (data ?? []).length > 0;
  cacheEnriquecimiento = { cargado_en: ahora, disponible };
  return disponible;
}

export function _limpiarCacheEnriquecimiento(): void {
  cacheEnriquecimiento = null;
}

// --- Recolección de filas ---------------------------------------------------

interface Recoleccion {
  filas: FilaArticulo[];
  total: number;
  filtrosUsados: FiltrosConsulta;
  degradado: boolean;
  avisos: Aviso[];
  pasos: PasoTraza[];
}

async function recolectar(filtros: FiltrosConsulta): Promise<Recoleccion> {
  const avisos: Aviso[] = [];
  const pasos: PasoTraza[] = [];

  // Pase 0: por significado, cuando la pregunta trae un tema ("¿qué se ha
  // escrito sobre la comida mexicana?"). El Pase A exigía que el tema fuera
  // una etiqueta exacta del enriquecimiento Y la palabra literal en el texto:
  // casi nunca las dos. Si la búsqueda por significado no está instalada o no
  // encuentra nada, se sigue con los pases de siempre.
  if (hayTema(filtros)) {
    try {
      const sig = await buscarPorSignificado(filtros, PANORAMA_POR_SIGNIFICADO, { expandir: true });
      pasos.push(...sig.pasosPrevios, sig.paso);
      if (sig.candidatos.length > 0) {
        avisos.push(...sig.avisos);
        return {
          filas: sig.candidatos,
          total: sig.candidatos.length,
          filtrosUsados: filtros,
          degradado: false,
          avisos,
          pasos,
        };
      }
    } catch (e) {
      if (!(e instanceof ErrorBuscar) || e.codigo !== 'BUSQUEDA_HIBRIDA_NO_DISPONIBLE') throw e;
      pasos.push({
        paso: 'degradacion',
        titulo: 'Búsqueda por significado no instalada',
        detalle: e.detalle ?? e.message,
        ms: 0,
      });
    }
  }

  const usaEnriquecimiento = filtros.anios_referidos.length > 0 || filtros.temas.length > 0;
  const hayEnriquecimiento = usaEnriquecimiento ? await enriquecimientoDisponible() : true;

  // Pase A: el bueno. `anios_referidos` y `temas` son campos de enriquecimiento.
  if (!usaEnriquecimiento || hayEnriquecimiento) {
    const t0 = performance.now();
    const { filas, total } = await buscarArticulos(filtros, { limite: PANORAMA_MAX_FILAS });
    pasos.push({
      paso: 'sql',
      titulo: 'Consultó el archivo',
      detalle: `${describirFiltros(filtros)} · ${total} coincidencias · ${filas.length} fichas al modelo`,
      ms: Math.round(performance.now() - t0),
    });
    if (filas.length > 0) {
      return { filas, total, filtrosUsados: filtros, degradado: false, avisos, pasos };
    }
  } else {
    avisos.push({
      codigo: 'ENRIQUECIMIENTO_PENDIENTE',
      mensaje:
        'El enriquecimiento del archivo todavía no corre: no hay resumen ni "años referidos" en la base.',
      detalle:
        'Sin `resumen_linea` ni `anios_referidos`, el panorama se arma con títulos, autores y fechas. ' +
        'Corre el paso 3 del orden de trabajo (enriquecimiento con Haiku) para tener el carril completo.',
    });
    pasos.push({
      paso: 'degradacion',
      titulo: 'Panorama degradado',
      detalle: 'Sin enriquecimiento: se ignoran `anios_referidos` y `temas`, y se busca en títulos.',
      ms: 0,
    });
  }

  // Pase B: sin campos de enriquecimiento. Los años pasan a ser palabras del
  // texto, no un filtro de publicación.
  const palabras = [
    filtros.texto ?? '',
    ...filtros.temas,
    ...filtros.anios_referidos.map(String),
  ].filter((p) => p !== '').join(' ').trim();

  const filtrosB: FiltrosConsulta = {
    autores: filtros.autores,
    rango_pub: null,
    anios_referidos: [],
    temas: [],
    texto: palabras || null,
    seccion: filtros.seccion,
  };

  const t1 = performance.now();
  const b = await buscarArticulos(filtrosB, { limite: PANORAMA_MAX_FILAS });
  pasos.push({
    paso: 'sql',
    titulo: 'Buscó en títulos y autores',
    detalle: `${describirFiltros(filtrosB)} · ${b.total} coincidencias`,
    ms: Math.round(performance.now() - t1),
  });

  let filas = b.filas;
  let total = b.total;
  let filtrosUsados = filtrosB;

  // Pase C: si con títulos apenas hay material y la pregunta traía años, se
  // COMPLEMENTA (no se acota) con lo publicado en esos años, y se declara.
  if (filas.length < PANORAMA_MIN_FILAS && filtros.anios_referidos.length > 0) {
    const anios = filtros.anios_referidos;
    const filtrosC: FiltrosConsulta = {
      autores: filtros.autores,
      rango_pub: { desde: Math.min(...anios), hasta: Math.max(...anios) },
      anios_referidos: [],
      temas: [],
      texto: null,
      seccion: filtros.seccion,
    };
    const t2 = performance.now();
    const c = await buscarArticulos(filtrosC, {
      limite: Math.max(0, PANORAMA_MAX_FILAS - filas.length),
    });
    pasos.push({
      paso: 'sql',
      titulo: 'Complementó con lo publicado en esos años',
      detalle: `${describirFiltros(filtrosC)} · ${c.total} coincidencias`,
      ms: Math.round(performance.now() - t2),
    });
    if (c.filas.length > 0) {
      const vistos = new Set(filas.map((f) => f.id));
      filas = [...filas, ...c.filas.filter((f) => !vistos.has(f.id))];
      total = total + c.total;
      filtrosUsados = { ...filtrosB, rango_pub: filtrosC.rango_pub };
      avisos.push({
        codigo: 'ANIOS_POR_PUBLICACION',
        mensaje:
          'Se incluyeron textos publicados en esos años, no solo los que hablan de ellos.',
        detalle:
          'Es un complemento explícito, no un filtro: sin enriquecimiento no existe todavía ' +
          'la distinción entre año de publicación y época de la que habla el texto.',
      });
    }
  }

  return { filas, total, filtrosUsados, degradado: true, avisos, pasos };
}

// --- La única llamada al LLM ------------------------------------------------

async function redactarSintesis(
  pregunta: string,
  filas: FilaArticulo[],
): Promise<{ sintesis: Sintesis; articulo_ids: number[] }> {
  // Hasta 40 citas: 3–6 temáticas con 2–5 textos cada una.
  const r = await redactar('panorama', pregunta, filas, 40);
  return {
    sintesis: {
      texto: r.texto,
      // La interfaz solo enseña `texto`, así que las temáticas van ahí, como
      // párrafos con sus citas, y no en un arreglo aparte que nadie ve.
      temas: [],
      fichas_consideradas: filas.length,
      modelo: r.modelo,
    },
    articulo_ids: r.articulo_ids,
  };
}

// --- Carril -----------------------------------------------------------------

export async function carrilPanorama(
  pregunta: string,
  filtros: FiltrosConsulta,
  avisosPrevios: Aviso[] = [],
): Promise<ResultadoCarril> {
  const avisos = [...avisosPrevios];

  // Sin tema, autor ni años no hay de qué hacer un panorama: lo que llegaría
  // al modelo serían 400 fichas cualesquiera del archivo, y su respuesta,
  // ruido pagado. Se dice y se pide precisar, sin gastar el modelo. Va como
  // `conversacion` para que la interfaz lo pinte como texto y no como "el
  // archivo está vacío" (total 0 sin resultados).
  if (!hayFiltros(filtros)) {
    return {
      modo: 'conversacion',
      fichas: [],
      total: 0,
      pagina: 1,
      por_pagina: 0,
      aproximados: false,
      reformulacion: null,
      sintesis: {
        texto: 'No alcancé a distinguir de qué tema, persona o época quieres el panorama. ' +
          'Prueba con algo como «¿Qué se ha escrito sobre el movimiento estudiantil de 1968?» o ' +
          '«¿Qué ha escrito Carlos Monsiváis sobre el cine?».',
        temas: [],
        fichas_consideradas: 0,
        modelo: 'calculado',
      },
      filtros,
      avisos,
      pasos: [{
        paso: 'router',
        titulo: 'La pregunta no trae un tema reconocible',
        detalle: 'Sin tema, autor ni años: no se consultó el modelo.',
        ms: 0,
      }],
    };
  }

  const rec = await recolectar(filtros);
  avisos.push(...rec.avisos);
  const pasos = [...rec.pasos];

  if (rec.filas.length === 0) {
    const aprox = await aproximar(filtros);
    return {
      modo: 'panorama',
      fichas: aprox.fichas,
      total: aprox.fichas.length,
      pagina: 1,
      por_pagina: aprox.fichas.length,
      aproximados: true,
      reformulacion: aprox.reformulacion,
      sintesis: null,
      filtros,
      avisos,
      pasos: [...pasos, aprox.paso],
    };
  }

  const filas = rec.filas.slice(0, PANORAMA_MAX_FILAS);
  const sinResumen = filas.every((f) => !f.resumen_linea);
  if (sinResumen) {
    avisos.push({
      codigo: 'SINTESIS_SIN_RESUMEN',
      mensaje: 'La síntesis se hizo solo con títulos, autores y fechas: el archivo aún no tiene resúmenes.',
      detalle: 'Ninguna de las fichas consideradas tiene `resumen_linea`.',
    });
  }

  const fichasTodas = armarFichas(filas);
  const porId = new Map<number, Ficha>(fichasTodas.map((f) => [f.id, f]));

  if (!hayModelo()) {
    avisos.push({
      codigo: 'SINTESIS_NO_DISPONIBLE',
      mensaje: 'No se pudo redactar la síntesis: falta configurar la llave de Gemini.',
      detalle: 'GEMINI_API_KEY no está definida. Se devuelven las fichas sin agrupar.',
    });
    return {
      modo: 'panorama',
      fichas: fichasTodas.slice(0, 20),
      total: rec.total,
      pagina: 1,
      por_pagina: 20,
      aproximados: rec.degradado,
      reformulacion: null,
      sintesis: null,
      filtros: rec.filtrosUsados,
      avisos,
      pasos,
    };
  }

  const t0 = performance.now();
  try {
    const { sintesis, articulo_ids } = await redactarSintesis(pregunta, filas);
    pasos.push({
      paso: 'sintesis',
      titulo: `Leyó ${filas.length} fichas y citó ${articulo_ids.length}`,
      detalle: `${sintesis.modelo} · una sola llamada`,
      ms: Math.round(performance.now() - t0),
    });

    // Las fichas que se enseñan son las que el modelo citó, armadas desde la
    // base. Un id que no existiera ya fue descartado por la validación.
    const citadas: Ficha[] = articulo_ids
      .map((id) => porId.get(id))
      .filter((f): f is Ficha => Boolean(f));

    return {
      modo: 'panorama',
      fichas: citadas,
      total: rec.total,
      pagina: 1,
      por_pagina: citadas.length,
      aproximados: rec.degradado,
      reformulacion: null,
      sintesis,
      filtros: rec.filtrosUsados,
      avisos,
      pasos,
    };
  } catch (e) {
    // La síntesis es la capa fácil; las fichas son el producto. Si el modelo
    // falla o devuelve algo que no cumple el esquema, se devuelven las fichas
    // reales con el error tipado a la vista. Nunca se calla.
    const error = e instanceof ErrorBuscar
      ? e
      : new ErrorBuscar('LLM_ERROR', 'Falló la redacción de la síntesis.', {
        detalle: e instanceof Error ? e.message : String(e),
      });
    avisos.push({
      codigo: error.codigo,
      mensaje: `${error.message} Se muestran las fichas del archivo sin agrupar.`,
      detalle: error.detalle,
    });
    pasos.push({
      paso: 'sintesis',
      titulo: 'La síntesis no se pudo redactar',
      detalle: `${error.codigo}: ${error.detalle ?? error.message}`,
      ms: Math.round(performance.now() - t0),
    });
    return {
      modo: 'panorama',
      fichas: fichasTodas.slice(0, 20),
      total: rec.total,
      pagina: 1,
      por_pagina: 20,
      aproximados: rec.degradado,
      reformulacion: null,
      sintesis: null,
      filtros: rec.filtrosUsados,
      avisos,
      pasos,
    };
  }
}
