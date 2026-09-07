/**
 * Cliente de las Edge Functions.
 *
 * Único punto del frontend que habla con el backend. No hay ni puede haber
 * un `supabase.from(...)` aquí ni en ninguna otra parte de `src/`: el
 * archivo es contenido de pago y la anon key vive en el navegador
 * (CLAUDE.md sección 6).
 */

import type {
  ErrorApi,
  RespuestaBuscar,
  RespuestaFacetas,
  SolicitudBuscar,
} from './contrato';
import { obtenerTokenSesion, ANON_KEY, URL_SUPABASE } from './sesion';

/** A los 10 s la UI avisa que va lento; a los 45 s se aborta (sección 3, mejora 1). */
export const MS_AVISO_LENTO = 10_000;
export const MS_LIMITE = 45_000;

export class ErrorConsulta extends Error {
  readonly codigo: string;
  readonly detalle: string | null;

  constructor(codigo: string, mensaje: string, detalle: string | null = null) {
    super(mensaje);
    this.name = 'ErrorConsulta';
    this.codigo = codigo;
    this.detalle = detalle;
  }
}

function sinConfigurar(): ErrorConsulta {
  return new ErrorConsulta(
    'sin_configurar',
    'Falta configurar la conexión con el archivo.',
    'Define VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY en web/.env.local y vuelve a levantar el servidor.',
  );
}

async function llamar<T>(funcion: string, cuerpo: unknown, senal?: AbortSignal): Promise<T> {
  if (!URL_SUPABASE || !ANON_KEY) throw sinConfigurar();

  const token = await obtenerTokenSesion();

  let respuesta: Response;
  try {
    respuesta = await fetch(`${URL_SUPABASE}/functions/v1/${funcion}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: ANON_KEY,
        authorization: `Bearer ${token ?? ANON_KEY}`,
      },
      body: JSON.stringify(cuerpo),
      signal: senal ?? null,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ErrorConsulta(
      'sin_red',
      'No se pudo llegar al archivo. Revisa tu conexión.',
      error instanceof Error ? error.message : null,
    );
  }

  const texto = await respuesta.text();
  let datos: unknown = null;
  if (texto) {
    try {
      datos = JSON.parse(texto);
    } catch {
      throw new ErrorConsulta(
        'respuesta_invalida',
        'El archivo respondió algo que no se pudo leer.',
        texto.slice(0, 400),
      );
    }
  }

  if (!respuesta.ok) {
    const tipado = datos as ErrorApi | null;
    if (tipado?.error?.mensaje) {
      throw new ErrorConsulta(
        tipado.error.codigo || String(respuesta.status),
        tipado.error.mensaje,
        tipado.error.detalle ?? null,
      );
    }
    throw new ErrorConsulta(
      String(respuesta.status),
      respuesta.status === 429
        ? 'Alcanzaste el límite de consultas por hora.'
        : 'El archivo devolvió un error.',
      `HTTP ${respuesta.status} ${respuesta.statusText}`,
    );
  }

  if (datos === null) {
    throw new ErrorConsulta('respuesta_vacia', 'El archivo respondió sin contenido.');
  }

  return datos as T;
}

/**
 * Valida la forma de la respuesta antes de renderizarla (sección 7, regla 5).
 * Si el backend cambia el contrato, se ve como un error tipado en pantalla,
 * no como una pantalla en blanco.
 */
function validarBuscar(datos: unknown): RespuestaBuscar {
  const d = datos as Partial<RespuestaBuscar> | null;
  const modosValidos = ['panorama', 'hibrida', 'catalogo'];
  const ok =
    !!d &&
    typeof d === 'object' &&
    typeof d.modo === 'string' &&
    modosValidos.includes(d.modo) &&
    Array.isArray(d.articulos) &&
    Array.isArray(d.traza) &&
    typeof d.total === 'number';

  if (!ok) {
    throw new ErrorConsulta(
      'contrato_roto',
      'La respuesta del archivo no tiene la forma esperada.',
      JSON.stringify(datos).slice(0, 400),
    );
  }

  // Se descarta cualquier artículo sin los campos con los que se arma la
  // ficha: preferimos mostrar de menos que mostrar una ficha a medias.
  const articulos = (d.articulos ?? []).filter(
    (a) =>
      a &&
      typeof a.id === 'number' &&
      typeof a.url === 'string' &&
      typeof a.titulo === 'string' &&
      typeof a.fecha_pub === 'string',
  );

  return {
    modo: d.modo as RespuestaBuscar['modo'],
    pregunta: typeof d.pregunta === 'string' ? d.pregunta : '',
    respuesta: typeof d.respuesta === 'string' ? d.respuesta : null,
    articulos: articulos.map((a) => ({
      ...a,
      autores: Array.isArray(a.autores) ? a.autores.filter((x) => typeof x === 'string') : [],
      numero: typeof a.numero === 'string' ? a.numero : null,
      seccion: typeof a.seccion === 'string' ? a.seccion : null,
      resumen_linea: typeof a.resumen_linea === 'string' ? a.resumen_linea : null,
    })),
    total: d.total ?? 0,
    traza: (d.traza ?? []).map((p) => ({
      titulo: typeof p?.titulo === 'string' ? p.titulo : 'Paso sin nombre',
      subtitulo: typeof p?.subtitulo === 'string' ? p.subtitulo : null,
      detalle: typeof p?.detalle === 'string' ? p.detalle : null,
      icono: p?.icono ?? null,
      ms: typeof p?.ms === 'number' ? p.ms : null,
    })),
    aproximados: d.aproximados === true,
    sugerencia: typeof d.sugerencia === 'string' ? d.sugerencia : null,
    archivo_vacio: d.archivo_vacio === true,
    ms: typeof d.ms === 'number' ? d.ms : 0,
  };
}

export async function buscar(
  solicitud: SolicitudBuscar,
  senal?: AbortSignal,
): Promise<RespuestaBuscar> {
  return validarBuscar(await llamar<unknown>('buscar', solicitud, senal));
}

export async function facetas(senal?: AbortSignal): Promise<RespuestaFacetas> {
  const datos = await llamar<Partial<RespuestaFacetas>>('facetas', {}, senal);
  const lista = (v: unknown) =>
    Array.isArray(v)
      ? v.filter(
          (f): f is { nombre: string; n: number } =>
            !!f && typeof f.nombre === 'string' && typeof f.n === 'number',
        )
      : [];

  return {
    autores: lista(datos.autores),
    secciones: lista(datos.secciones),
    decadas: lista(datos.decadas),
    total_articulos: typeof datos.total_articulos === 'number' ? datos.total_articulos : 0,
    anio_min: typeof datos.anio_min === 'number' ? datos.anio_min : null,
    anio_max: typeof datos.anio_max === 'number' ? datos.anio_max : null,
  };
}
