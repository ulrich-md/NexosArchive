// Edge Function `buscar` — el cerebro del Archivo Nexos.
// Ver CLAUDE.md secciones 4 (los tres carriles), 6 (seguridad) y 7 (reglas
// anti-alucinación). Paso 4 del orden de trabajo (sección 9).
//
// Orden de lo que pasa en cada petición:
//   1. CORS y validación de la petición.
//   2. Sesión + lista blanca de dominio, en el servidor.
//   3. Router: modo explícito de la UI → heurística determinista → Haiku.
//   4. Límite de 30 consultas/hora, justo antes de la primera llamada a un LLM.
//   5. Carril: catalogo (SQL puro) · panorama (una llamada al modelo) ·
//      hibrida (significado + palabras en una consulta, y una llamada al
//      modelo que elige y redacta). Si la búsqueda por significado no está
//      instalada (migración 0006), degrada a catálogo con error tipado.
//   6. Bitácora en `consultas` y respuesta con traza.
//
// QUÉ QUEDA SIN VERIFICAR (a la fecha de escritura):
//   - La búsqueda por significado se probó contra Postgres 16 + pgvector 0.8
//     con datos sintéticos, no contra el archivo real: la distancia máxima
//     (HIBRIDA_DISTANCIA_MAX) está sin calibrar. La traza la enseña.
//   - Las pruebas de `pruebas.test.ts` cubren solo funciones puras
//     (`deno test --allow-env supabase/functions/buscar/pruebas.test.ts`).

import { autenticar } from './auth.ts';
import { archivoVacio } from './bd.ts';
import { registrarConsulta, verificarLimite } from './bitacora.ts';
import { PREGUNTA_MAX_CARACTERES, TIMEOUT_TOTAL_MS } from './config.ts';
import { comoErrorBuscar, ErrorBuscar } from './errores.ts';
import { encabezadosCors, respuestaError, respuestaJson } from './http.ts';
import { clasificar, clasificarHeuristica, filtrosParaModoExplicito, reformularSeguimiento } from './router.ts';
import { detectaSeguimiento, detectarCharla, quitarCortesia } from './texto.ts';
import { responderCharla } from './charla.ts';
import { validarFiltrosEco } from './validacion.ts';
import { carrilCatalogo, normalizarPaginacion } from './carriles/catalogo.ts';
import { carrilPanorama } from './carriles/panorama.ts';
import { carrilHibrida } from './carriles/hibrida.ts';
import { hayTema } from './carriles/significado.ts';
import { aFiltrosAplicados, type FiltrosConsulta, type ResultadoCarril } from './carriles/comun.ts';
import type { Clasificacion } from './router.ts';
import {
  VERSION_CONTRATO,
  type Aviso,
  type FiltrosAplicados,
  type Modo,
  type PasoTraza,
  type Peticion,
  type RespuestaOk,
} from './tipos.ts';

const MODOS: Modo[] = ['panorama', 'hibrida', 'catalogo'];

function validarPeticion(cuerpo: unknown): Peticion {
  if (typeof cuerpo !== 'object' || cuerpo === null || Array.isArray(cuerpo)) {
    throw new ErrorBuscar('CUERPO_INVALIDO', 'La petición no trae un cuerpo JSON válido.');
  }
  const c = cuerpo as Record<string, unknown>;

  const pregunta = typeof c.pregunta === 'string' ? c.pregunta.trim() : '';
  if (pregunta === '') {
    throw new ErrorBuscar('PREGUNTA_VACIA', 'Escribe una pregunta para consultar el archivo.');
  }
  if (pregunta.length > PREGUNTA_MAX_CARACTERES) {
    throw new ErrorBuscar(
      'PREGUNTA_MUY_LARGA',
      `La pregunta no puede pasar de ${PREGUNTA_MAX_CARACTERES} caracteres.`,
      { detalle: `Llegaron ${pregunta.length}.` },
    );
  }

  let modo: Modo | undefined;
  if (c.modo !== undefined && c.modo !== null) {
    if (typeof c.modo !== 'string' || !MODOS.includes(c.modo as Modo)) {
      throw new ErrorBuscar(
        'MODO_INVALIDO',
        'El modo pedido no existe.',
        { detalle: `Modos válidos: ${MODOS.join(', ')}.` },
      );
    }
    modo = c.modo as Modo;
  }

  const preguntaAnteriorCruda = typeof c.pregunta_anterior === 'string' ? c.pregunta_anterior.trim() : '';

  return {
    pregunta,
    modo,
    pagina: typeof c.pagina === 'number' ? c.pagina : undefined,
    por_pagina: typeof c.por_pagina === 'number' ? c.por_pagina : undefined,
    // Se acota al mismo largo que la pregunta: no tiene sentido que el
    // contexto pese más que la consulta misma.
    pregunta_anterior:
      preguntaAnteriorCruda && preguntaAnteriorCruda.length <= PREGUNTA_MAX_CARACTERES
        ? preguntaAnteriorCruda
        : null,
    filtros: validarFiltrosEco(c.filtros),
  };
}

function deFiltrosAplicados(f: FiltrosAplicados): FiltrosConsulta {
  return {
    autores: f.autores,
    rango_pub: f.anios_pub,
    anios_referidos: f.anios_referidos,
    temas: f.temas,
    texto: f.texto,
    seccion: f.seccion,
  };
}

/** Cómo se entendió la pregunta, dicho para el editor y no con jerga interna. */
function comoSeEntendio(c: Clasificacion): string {
  const via = {
    explicito: '',
    heuristica: ' (sin usar el modelo)',
    llm: ' (con ayuda del modelo)',
    respaldo: ' (por reglas: el modelo no respondió)',
  }[c.origen];
  return `${c.razon}${via}`;
}

/**
 * IP del cliente para el límite de tasa anónimo. El runtime de Supabase pone
 * la IP real en `x-forwarded-for` (puede traer varias, separadas por coma: la
 * primera es la del cliente). Sin esa cabecera no hay forma confiable de
 * identificar al anónimo — `verificarLimite` lo deja pasar en ese caso.
 */
function ipDeLaPeticion(req: Request): string | null {
  const cabecera = req.headers.get('x-forwarded-for');
  if (!cabecera) return null;
  const ip = cabecera.split(',')[0]?.trim();
  return ip || null;
}

function filtrosDeClasificacion(c: Clasificacion): FiltrosConsulta {
  return {
    autores: c.autores.map((a) => a.autor),
    rango_pub: c.rango_pub,
    anios_referidos: c.anios_referidos,
    temas: c.temas,
    texto: c.texto,
    seccion: null,
  };
}

async function manejar(
  req: Request,
  t0: number,
  traza: PasoTraza[],
  avisos: Aviso[],
): Promise<Response> {

  let cuerpoCrudo: unknown;
  try {
    cuerpoCrudo = await req.json();
  } catch {
    throw new ErrorBuscar('CUERPO_INVALIDO', 'La petición no trae un cuerpo JSON válido.');
  }

  const peticion = validarPeticion(cuerpoCrudo);
  const sesion = await autenticar(req);
  const ip = ipDeLaPeticion(req);

  let limiteVerificado = false;
  const verificarLimiteUnaVez = async () => {
    if (limiteVerificado) return;
    await verificarLimite(sesion.usuario_id, ip);
    limiteVerificado = true;
  };

  // --- Otra página de una búsqueda ya hecha -----------------------------------
  // Con el eco de sus filtros no hay nada que reinterpretar: ni router, ni
  // hilo, ni modelo. Es el mismo WHERE con otro OFFSET.
  if (peticion.filtros && (peticion.pagina ?? 1) > 1) {
    const filtrosEco = deFiltrosAplicados(peticion.filtros);
    const paginacionEco = normalizarPaginacion({ pagina: peticion.pagina, por_pagina: peticion.por_pagina });
    const res = await carrilCatalogo(filtrosEco, paginacionEco, avisos);
    traza.push(...res.pasos);
    return respuestaJson(armarRespuesta(peticion.pregunta, 'catalogo', null, res, traza, t0), 200, req);
  }

  // --- Charla ---------------------------------------------------------------
  // La cortesía del principio ("Hola, ¿me puedes decir…") no es parte de lo
  // que se busca. Y si no queda nada más que cortesía, se contesta como tal.
  const preguntaLimpia = quitarCortesia(peticion.pregunta);
  const charla = detectarCharla(preguntaLimpia);
  if (charla) {
    const texto = await responderCharla(charla);
    registrarConsulta({
      usuario: sesion.usuario_id,
      ip,
      pregunta: peticion.pregunta,
      modo: 'conversacion',
      n_resultados: 0,
      ms: performance.now() - t0,
    });
    const res: ResultadoCarril = {
      modo: 'conversacion',
      fichas: [],
      total: 0,
      pagina: 1,
      por_pagina: 0,
      aproximados: false,
      reformulacion: null,
      sintesis: { texto, temas: [], fichas_consideradas: 0, modelo: 'calculado' },
      filtros: { autores: [], rango_pub: null, anios_referidos: [], temas: [], texto: null, seccion: null },
      avisos: [],
      pasos: [],
    };
    return respuestaJson(armarRespuesta(peticion.pregunta, 'conversacion', null, res, [], t0), 200, req);
  }

  // --- Seguimiento de conversación -------------------------------------------
  // Solo la pregunta INMEDIATAMENTE anterior: alcanza para "¿y en 2010?" o
  // "de esos, cuáles son de mujeres" sin que el router cargue con toda la
  // conversación. `detectaSeguimiento` es la compuerta barata que evita
  // pagar el viaje al modelo en cada pregunta nueva e independiente.
  let preguntaEfectiva = preguntaLimpia;
  if (peticion.pregunta_anterior && detectaSeguimiento(preguntaLimpia)) {
    await verificarLimiteUnaVez();
    const seguimiento = await reformularSeguimiento(peticion.pregunta_anterior, preguntaLimpia);
    if (seguimiento.siguioElHilo) {
      preguntaEfectiva = seguimiento.pregunta;
      traza.push({
        paso: 'router',
        titulo: 'Siguió el hilo de la conversación',
        detalle: `Entendió la pregunta como: «${preguntaEfectiva}»`,
        ms: 0,
      });
    }
  }

  // --- Router ---------------------------------------------------------------
  const tRouter = performance.now();

  // Los tres carriles están abiertos con o sin sesión (CLAUDE.md sección 6):
  // solo la audiencia interna de Nexos conoce esta URL, así que la sesión
  // sirve para conservar el historial de conversaciones, no para leer el
  // archivo. El límite de 30/hora sigue aplicando, por usuario o por IP.
  const permitirLlm = true;

  let clasificacion: Clasificacion | null = peticion.modo
    ? await filtrosParaModoExplicito(preguntaEfectiva, peticion.modo)
    : await clasificarHeuristica(preguntaEfectiva);

  if (!clasificacion) {
    await verificarLimiteUnaVez();
    clasificacion = await clasificar(preguntaEfectiva, null, permitirLlm);
  }

  avisos.push(...clasificacion.avisos);
  traza.push({
    paso: 'router',
    titulo: 'Interpretó la pregunta',
    // Nunca se nombra el carril interno (panorama/hibrida/catalogo) en texto
    // que ve el editor: es una decisión de costo/arquitectura, no un concepto
    // de producto (el usuario nunca elige "modo").
    detalle: comoSeEntendio(clasificacion),
    ms: Math.round(performance.now() - tRouter),
  });

  const modoSolicitado: Modo = clasificacion.modo;
  let degradado: RespuestaOk['degradado'] = null;

  const filtros = filtrosDeClasificacion(clasificacion);
  const paginacion = normalizarPaginacion({
    pagina: peticion.pagina,
    por_pagina: peticion.por_pagina,
  });

  // --- Carril ---------------------------------------------------------------
  let resultado: ResultadoCarril;

  // Una "búsqueda" sin tema es un filtro: no hay nada que buscar por
  // significado y no vale una llamada al modelo.
  if (clasificacion.modo === 'hibrida' && !hayTema(filtros)) {
    resultado = await carrilCatalogo(filtros, paginacion, avisos);
  } else if (clasificacion.modo === 'catalogo') {
    resultado = await carrilCatalogo(filtros, paginacion, avisos);
  } else if (clasificacion.modo === 'panorama') {
    await verificarLimiteUnaVez();
    resultado = await carrilPanorama(preguntaEfectiva, filtros, avisos);
  } else {
    // hibrida. Si la búsqueda por significado no está instalada en la base
    // (migración 0006 sin aplicar), se degrada a catálogo con error TIPADO y
    // se dice — nunca se cae en silencio.
    try {
      await verificarLimiteUnaVez();
      resultado = await carrilHibrida(preguntaEfectiva, filtros, avisos);
    } catch (e) {
      const err = comoErrorBuscar(e);
      if (err.codigo !== 'BUSQUEDA_HIBRIDA_NO_DISPONIBLE') throw err;

      degradado = {
        desde: 'hibrida',
        a: 'catalogo',
        codigo: err.codigo,
        mensaje: err.message,
      };
      traza.push({
        paso: 'degradacion',
        titulo: 'Búsqueda por significado no disponible',
        detalle: `${err.codigo}: ${err.detalle ?? err.message}`,
        ms: 0,
      });
      resultado = await carrilCatalogo(filtros, paginacion, avisos);
    }
  }

  traza.push(...resultado.pasos);

  // --- Archivo vacío: estado honesto, nunca datos de ejemplo ----------------
  if (resultado.fichas.length === 0 && resultado.total === 0 && await archivoVacio()) {
    throw new ErrorBuscar(
      'ARCHIVO_VACIO',
      'El archivo todavía no se ha cargado: no hay ni un artículo en la base.',
      {
        sugerencia: 'Corre la ingesta y revisa la reconciliación contra X-WP-Total.',
        liga: '/admin',
      },
    );
  }

  const ms = performance.now() - t0;

  registrarConsulta({
    usuario: sesion.usuario_id,
    ip,
    pregunta: preguntaEfectiva,
    modo: resultado.modo,
    n_resultados: resultado.fichas.length,
    ms,
  });

  return respuestaJson(
    armarRespuesta(preguntaEfectiva, modoSolicitado, degradado, resultado, traza, t0),
    200,
    req,
  );
}

function armarRespuesta(
  pregunta: string,
  modoSolicitado: Modo,
  degradado: RespuestaOk['degradado'],
  resultado: ResultadoCarril,
  traza: PasoTraza[],
  t0: number,
): RespuestaOk {
  return {
    ok: true,
    version: VERSION_CONTRATO,
    modo: resultado.modo,
    modo_solicitado: modoSolicitado,
    degradado,
    pregunta,
    filtros: aFiltrosAplicados(resultado.filtros),
    sintesis: resultado.sintesis,
    resultados: resultado.fichas,
    total: resultado.total,
    pagina: resultado.pagina,
    por_pagina: resultado.por_pagina,
    aproximados: resultado.aproximados,
    reformulacion: resultado.reformulacion,
    avisos: resultado.avisos,
    traza,
    ms: Math.round(performance.now() - t0),
  };
}

Deno.serve(async (req: Request) => {
  const t0 = performance.now();
  // La traza y los avisos viven fuera del manejador para que un error a mitad
  // de camino igual le enseñe al editor hasta dónde llegó la consulta.
  const traza: PasoTraza[] = [];
  const avisos: Aviso[] = [];

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: encabezadosCors(req) });
  }

  try {
    if (req.method !== 'POST') {
      throw new ErrorBuscar('METODO_NO_PERMITIDO', 'Esta función solo acepta POST.');
    }

    // Reloj de pared: más vale un error que dice "tardó demasiado" que una
    // pestaña congelada 30 segundos (CLAUDE.md sección 0).
    const vigilante = new Promise<never>((_, rechazar) => {
      setTimeout(
        () =>
          rechazar(
            new ErrorBuscar('TIEMPO_AGOTADO', 'La consulta tardó demasiado. Vuelve a intentarla.', {
              detalle: `Se agotaron ${TIMEOUT_TOTAL_MS} ms.`,
              sugerencia: 'Si se repite, acota la pregunta: por autor, por año o por sección responde más rápido.',
            }),
          ),
        TIMEOUT_TOTAL_MS,
      );
    });

    return await Promise.race([manejar(req, t0, traza, avisos), vigilante]);
  } catch (e) {
    const err = comoErrorBuscar(e);
    if (err.estado >= 500) {
      console.error(`[buscar] ${err.codigo}: ${err.message}`, err.detalle ?? '', err.causa ?? '');
    }
    return respuestaError(err, req, traza, avisos, performance.now() - t0);
  }
});
