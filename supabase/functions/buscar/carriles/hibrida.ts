// Carril `hibrida` (CLAUDE.md sección 4): "Artículos de 1988 sobre fraude
// electoral", "¿Qué ha escrito Ángeles Mastretta sobre comida?".
//
// Vectorial + texto completo, fusionados con Reciprocal Rank Fusion, con los
// filtros duros (autor, años) ANTES del ranking — todo en una sola consulta de
// Postgres (`buscar_articulos_hibrido`, migración 0006). Después, UNA llamada
// al modelo que hace a la vez de rerank y de redacción: lee los candidatos,
// descarta los que no tratan el tema y contesta citando por id.
//
// A nivel de ARTÍCULO, no de chunks: el vector sale del título, temas y
// resumen que dejó el enriquecimiento. La versión de chunks esperaba el cuerpo
// de la fase 2, que nunca llegó, y por eso este carril nunca había corrido:
// degradaba siempre a catálogo, que busca la palabra literal.
//
// Lo que no hace nunca: contestar vacío (sección 7, regla 3) ni enseñar
// candidatos que el modelo descartó como si fueran la respuesta.

import { HIBRIDA_CANDIDATOS, HIBRIDA_MAX_CITADAS, HIBRIDA_SIN_REDACCION, LECTURA_AUTOR_MAX } from '../config.ts';
import { ErrorBuscar } from '../errores.ts';
import { armarFichas } from '../fichas.ts';
import { hayModelo } from '../llm.ts';
import type { Aviso, Ficha, FilaArticulo, PasoTraza } from '../tipos.ts';
import { aproximar, buscarArticulos, type FiltrosConsulta, type ResultadoCarril } from './comun.ts';
import { redactar } from './redaccion.ts';
import { buscarPorSignificado, textoDeBusqueda } from './significado.ts';

export async function carrilHibrida(
  pregunta: string,
  filtrosCrudos: FiltrosConsulta,
  avisosPrevios: Aviso[] = [],
): Promise<ResultadoCarril> {
  // `temas` aquí son palabras del tema, no un filtro duro sobre las etiquetas
  // del enriquecimiento (ver `sinTemasFantasma` en catalogo.ts).
  const filtros: FiltrosConsulta = { ...filtrosCrudos, temas: [], texto: textoDeBusqueda(filtrosCrudos) };
  const avisos = [...avisosPrevios];

  // Sin tema no hay nada que buscar por significado: es un catálogo.
  if (!filtros.texto) {
    throw new ErrorBuscar('BUSQUEDA_HIBRIDA_NO_DISPONIBLE', 'La pregunta no trae un tema que buscar.', {
      detalle: 'Sin tema, la consulta es un filtro: se responde como catálogo.',
    });
  }

  const pasos: PasoTraza[] = [];
  let candidatos: FilaArticulo[] = [];

  // Con autor, si su obra cabe, el modelo la lee COMPLETA (título, temas y
  // resumen de cada texto) en vez de fiarse de una búsqueda: es la única
  // forma de no perder "La cocina de mi abuela" cuando se preguntó por
  // "comida". Cabe de sobra: las 876 fichas de Mastretta son ~70k tokens,
  // menos de un centavo con Haiku.
  let leyoTodo = false;
  if (filtros.autores.length > 0) {
    const t0 = performance.now();
    const obra = await buscarArticulos(
      { ...filtros, texto: null, temas: [] },
      { limite: LECTURA_AUTOR_MAX },
    );
    if (obra.total > 0 && obra.total <= LECTURA_AUTOR_MAX) {
      leyoTodo = true;
      // Con cientos de fichas, el modelo atiende más a las primeras: medido
      // con Mastretta (876), "La cocina de Marichu" quedaba fuera aunque su
      // título nombra el tema. Se ordena la obra: primero lo que coincide con
      // el tema ampliado (por significado y por palabras), luego el resto.
      // Nada se quita: el modelo sigue leyendo la obra completa.
      const busqueda = await buscarPorSignificado(filtros, 100, { expandir: true });
      avisos.push(...busqueda.avisos.filter((a) => a.codigo !== 'VECTORES_PENDIENTES'));
      pasos.push(...busqueda.pasosPrevios);
      const primero = new Set(busqueda.candidatos.map((c) => Number(c.id)));
      candidatos = [
        ...busqueda.candidatos,
        ...obra.filas.filter((f) => !primero.has(Number(f.id))),
      ];
      pasos.push({
        paso: 'sql',
        titulo: `Reunió toda la obra de ${filtros.autores.join(', ')}`,
        detalle: `${obra.total} textos${filtros.rango_pub ? ` publicados entre ${filtros.rango_pub.desde} y ${filtros.rango_pub.hasta}` : ''} · ` +
          `${primero.size} coinciden con el tema y van primero · el modelo los lee todos`,
        ms: Math.round(performance.now() - t0),
      });
    }
  }

  // Sin autor, o con una obra demasiado grande: búsqueda por significado y
  // por palabras, con el tema ampliado.
  if (!leyoTodo) {
    const busqueda = await buscarPorSignificado(filtros, HIBRIDA_CANDIDATOS, { expandir: true });
    avisos.push(...busqueda.avisos);
    pasos.push(...busqueda.pasosPrevios, busqueda.paso);
    candidatos = busqueda.candidatos;
  }

  // Ni por significado ni por palabras: lo más próximo, marcado como tal.
  if (candidatos.length === 0) {
    const aprox = await aproximar(filtros);
    return {
      modo: 'hibrida',
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

  const fichasTodas = armarFichas(candidatos);
  const porId = new Map<number, Ficha>(fichasTodas.map((f) => [Number(f.id), f]));
  const sinRedaccion = (aviso: Aviso, paso?: PasoTraza): ResultadoCarril => {
    const fichas = fichasTodas.slice(0, HIBRIDA_SIN_REDACCION);
    return {
      modo: 'hibrida',
      fichas,
      total: fichas.length,
      pagina: 1,
      por_pagina: fichas.length,
      aproximados: false,
      reformulacion: null,
      sintesis: null,
      filtros,
      avisos: [...avisos, aviso],
      pasos: paso ? [...pasos, paso] : pasos,
    };
  };

  if (!hayModelo()) {
    return sinRedaccion({
      codigo: 'SINTESIS_NO_DISPONIBLE',
      mensaje: 'No se pudo redactar la respuesta: falta la llave de Gemini. Se muestran los más cercanos.',
      detalle: 'GEMINI_API_KEY no está definida.',
    });
  }

  const t0 = performance.now();
  try {
    const r = await redactar('directa', pregunta, candidatos, HIBRIDA_MAX_CITADAS);
    pasos.push({
      paso: 'sintesis',
      titulo: `Leyó ${candidatos.length} fichas y eligió ${r.articulo_ids.length} que responden`,
      detalle: `${r.modelo} · una sola llamada`,
      ms: Math.round(performance.now() - t0),
    });

    const sintesis = {
      texto: r.texto,
      temas: [],
      fichas_consideradas: candidatos.length,
      modelo: r.modelo,
    };

    // El modelo leyó los candidatos y ninguno trata el tema: se dice, y se
    // enseñan los más cercanos marcados como aproximados (regla 3), nunca
    // como si fueran la respuesta.
    if (r.articulo_ids.length === 0) {
      const cercanos = fichasTodas.slice(0, 5);
      return {
        modo: 'hibrida',
        fichas: cercanos,
        total: cercanos.length,
        pagina: 1,
        por_pagina: cercanos.length,
        aproximados: true,
        reformulacion:
          `Ninguno de los ${candidatos.length} textos más cercanos trata de «${filtros.texto}». ` +
          'Se muestran los más próximos. Prueba con otra palabra para el tema, o sin acotar el autor o el año.',
        sintesis,
        filtros,
        avisos,
        pasos,
      };
    }

    const fichas = r.articulo_ids.map((id) => porId.get(id)).filter((f): f is Ficha => Boolean(f));
    return {
      modo: 'hibrida',
      fichas,
      total: fichas.length,
      pagina: 1,
      por_pagina: fichas.length,
      aproximados: false,
      reformulacion: null,
      sintesis,
      filtros,
      avisos,
      pasos,
    };
  } catch (e) {
    // Las fichas son el producto; la redacción es la capa fácil. Si el modelo
    // falla, se enseñan los mejores candidatos por RRF con el error a la vista.
    const error = e instanceof ErrorBuscar
      ? e
      : new ErrorBuscar('LLM_ERROR', 'Falló la redacción de la respuesta.', {
        detalle: e instanceof Error ? e.message : String(e),
      });
    return sinRedaccion(
      {
        codigo: error.codigo,
        mensaje: `${error.message} Se muestran los textos más cercanos, sin redactar.`,
        detalle: error.detalle,
      },
      {
        paso: 'sintesis',
        titulo: 'La respuesta no se pudo redactar',
        detalle: `${error.codigo}: ${error.detalle ?? error.message}`,
        ms: Math.round(performance.now() - t0),
      },
    );
  }
}
