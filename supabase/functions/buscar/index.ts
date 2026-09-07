// Edge Function `buscar` — el cerebro del Archivo Nexos.
// Ver CLAUDE.md secciones 4 (los tres carriles), 6 (seguridad) y 7 (reglas
// anti-alucinación). Paso 4 del orden de trabajo (sección 9).
//
// Orden de lo que pasa en cada petición:
//   1. CORS y validación de la petición.
//   2. Sesión + lista blanca de dominio, en el servidor.
//   3. Router: modo explícito de la UI → heurística determinista → Haiku.
//   4. Límite de 30 consultas/hora, justo antes de la primera llamada a un LLM.
//   5. Carril: catalogo (SQL puro) · panorama (una llamada a Sonnet) ·
//      hibrida (fase 2, detrás de bandera; degrada con error tipado).
//   6. Bitácora en `consultas` y respuesta con traza.
//
// QUÉ QUEDA SIN VERIFICAR (a la fecha de escritura):
//   - El carril `hibrida` NO se ha ejecutado nunca: no hay chunks ni embeddings
//     y la RPC de búsqueda vectorial la crea la fase 2. Está detrás de bandera.
//   - El carril `panorama` no se ha ejecutado con `resumen_linea` ni
//     `anios_referidos` poblados: el enriquecimiento (paso 3) todavía no corre.
//     Mientras tanto degrada de forma explícita, con aviso y traza.
//   - Las llamadas a Claude no se han corrido contra la API real desde aquí.
//   - Las pruebas de `pruebas.test.ts` cubren solo funciones puras
//     (`deno test --allow-env supabase/functions/buscar/pruebas.test.ts`).

import { autenticar } from './auth.ts';
import { archivoVacio } from './bd.ts';
import { registrarConsulta, verificarLimite } from './bitacora.ts';
import { PREGUNTA_MAX_CARACTERES, TIMEOUT_TOTAL_MS } from './config.ts';
import { comoErrorBuscar, ErrorBuscar } from './errores.ts';
import { encabezadosCors, respuestaError, respuestaJson } from './http.ts';
import { clasificar, clasificarHeuristica, filtrosParaModoExplicito } from './router.ts';
import { carrilCatalogo, normalizarPaginacion } from './carriles/catalogo.ts';
import { carrilPanorama } from './carriles/panorama.ts';
import { carrilHibrida } from './carriles/hibrida.ts';
import { aFiltrosAplicados, type FiltrosConsulta, type ResultadoCarril } from './carriles/comun.ts';
import type { Clasificacion } from './router.ts';
import {
  VERSION_CONTRATO,
  type Aviso,
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

  return {
    pregunta,
    modo,
    pagina: typeof c.pagina === 'number' ? c.pagina : undefined,
    por_pagina: typeof c.por_pagina === 'number' ? c.por_pagina : undefined,
  };
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

  // --- Router ---------------------------------------------------------------
  const tRouter = performance.now();
  let limiteVerificado = false;
  const verificarLimiteUnaVez = async () => {
    if (limiteVerificado) return;
    await verificarLimite(sesion.usuario_id);
    limiteVerificado = true;
  };

  // Los anónimos (solo si ACCESO_ANONIMO está encendido) no tocan ningún LLM:
  // no hay a quién cobrarle el límite de 30 consultas/hora.
  const permitirLlm = !sesion.anonimo;

  let clasificacion: Clasificacion | null = peticion.modo
    ? await filtrosParaModoExplicito(peticion.pregunta, peticion.modo)
    : await clasificarHeuristica(peticion.pregunta);

  if (!clasificacion) {
    if (permitirLlm) await verificarLimiteUnaVez();
    clasificacion = await clasificar(peticion.pregunta, null, permitirLlm);
  }

  avisos.push(...clasificacion.avisos);
  traza.push({
    paso: 'router',
    titulo: 'Clasificó la consulta',
    detalle: `modo ${clasificacion.modo} · ${clasificacion.origen} · ${clasificacion.razon}`,
    ms: Math.round(performance.now() - tRouter),
  });

  const modoSolicitado: Modo = clasificacion.modo;
  let degradado: RespuestaOk['degradado'] = null;

  if (sesion.anonimo && clasificacion.modo !== 'catalogo') {
    degradado = {
      desde: clasificacion.modo,
      a: 'catalogo',
      codigo: 'SESION_REQUERIDA',
      mensaje: 'Sin sesión solo está disponible el catálogo. Inicia sesión para el resto.',
    };
    avisos.push({ codigo: 'SESION_REQUERIDA', mensaje: degradado.mensaje });
    clasificacion = { ...clasificacion, modo: 'catalogo' };
  }

  const filtros = filtrosDeClasificacion(clasificacion);
  const paginacion = normalizarPaginacion({
    pagina: peticion.pagina,
    por_pagina: peticion.por_pagina,
  });

  // --- Carril ---------------------------------------------------------------
  let resultado: ResultadoCarril;

  if (clasificacion.modo === 'catalogo') {
    resultado = await carrilCatalogo(filtros, paginacion, avisos);
  } else if (clasificacion.modo === 'panorama') {
    await verificarLimiteUnaVez();
    resultado = await carrilPanorama(peticion.pregunta, filtros, avisos);
  } else {
    // hibrida: fase 2. Con la bandera apagada lanza un error TIPADO y se
    // degrada al carril que sí puede responder — nunca se cae en silencio.
    try {
      await verificarLimiteUnaVez();
      resultado = await carrilHibrida(peticion.pregunta, filtros, avisos);
    } catch (e) {
      const err = comoErrorBuscar(e);
      if (err.codigo !== 'FASE2_INACTIVA' && err.codigo !== 'FASE2_INCOMPLETA') throw err;

      degradado = {
        desde: 'hibrida',
        a: 'catalogo',
        codigo: err.codigo,
        mensaje: err.message,
      };
      avisos.push({
        codigo: err.codigo,
        mensaje: err.message,
        detalle: err.detalle,
      });
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
    pregunta: peticion.pregunta,
    modo: resultado.modo,
    n_resultados: resultado.fichas.length,
    ms,
  });

  const respuesta: RespuestaOk = {
    ok: true,
    version: VERSION_CONTRATO,
    modo: resultado.modo,
    modo_solicitado: modoSolicitado,
    degradado,
    pregunta: peticion.pregunta,
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
    ms: Math.round(ms),
  };

  return respuestaJson(respuesta, 200, req);
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
              sugerencia: 'Si se repite, acota la pregunta o usa el modo Catálogo.',
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
