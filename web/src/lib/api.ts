/**
 * Cliente de las Edge Functions.
 *
 * Único punto del frontend que habla con el backend. No hay ni puede haber
 * un `supabase.from(...)` aquí ni en ninguna otra parte de `src/`: el
 * archivo es contenido de pago y la anon key vive en el navegador
 * (CLAUDE.md sección 6).
 */

import type {
  Articulo,
  ErrorApi,
  PasoTraza,
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

function errorDeRespuesta(estado: number, textoEstado: string, datos: unknown): ErrorConsulta {
  const tipado = datos as ErrorApi | null;
  if (tipado?.error?.mensaje) {
    return new ErrorConsulta(
      tipado.error.codigo || String(estado),
      tipado.error.mensaje,
      tipado.error.detalle ?? null,
    );
  }
  return new ErrorConsulta(
    String(estado),
    estado === 429 ? 'Alcanzaste el límite de consultas por hora.' : 'El archivo devolvió un error.',
    `HTTP ${estado} ${textoEstado}`,
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

  if (!respuesta.ok) throw errorDeRespuesta(respuesta.status, respuesta.statusText, datos);

  if (datos === null) {
    throw new ErrorConsulta('respuesta_vacia', 'El archivo respondió sin contenido.');
  }

  return datos as T;
}

/** El paso del backend decide qué icono le toca en la traza. */
const ICONO_POR_PASO: Record<string, PasoTraza['icono']> = {
  router: 'interpretacion',
  sql: 'consulta',
  sintesis: 'redaccion',
  rerank: 'orden',
  degradacion: 'filtro',
  aproximacion: 'lectura',
};

/**
 * La Edge Function usa nombres propios (`resultados`, `sintesis`,
 * `reformulacion`) y además devuelve cosas que este contrato no contempla:
 * `degradado` cuando sirvió por otro carril, y `avisos` cuando degradó de
 * forma declarada. Aquí se traduce a la forma que espera la interfaz y, sobre
 * todo, NO se tiran esos mensajes: se muestran como pasos de la traza, porque
 * son justo lo que le explica al editor por qué obtuvo lo que obtuvo.
 */
function deFormaBackend(d: Record<string, unknown>): Record<string, unknown> {
  if (!('resultados' in d) && !('sintesis' in d)) return d; // ya viene en la forma esperada

  const traza = Array.isArray(d.traza) ? [...(d.traza as Record<string, unknown>[])] : [];

  const degradado = d.degradado as { desde: string; a: string; mensaje: string } | null;
  if (degradado) {
    // Nunca se nombran los carriles internos (CLAUDE.md sección 3): el
    // mensaje del backend ya dice qué pasó en términos del editor.
    traza.push({
      paso: 'degradacion',
      titulo: degradado.mensaje,
      detalle: '',
      ms: 0,
    });
  }

  for (const aviso of (d.avisos ?? []) as { mensaje?: string; detalle?: string }[]) {
    if (aviso?.mensaje) {
      traza.push({ paso: 'degradacion', titulo: aviso.mensaje, detalle: aviso.detalle ?? '', ms: 0 });
    }
  }

  const sintesis = d.sintesis as { texto?: string } | null;

  return {
    ...d,
    articulos: d.resultados,
    respuesta: typeof sintesis?.texto === 'string' ? sintesis.texto : null,
    sugerencia: d.reformulacion ?? null,
    archivo_vacio:
      d.modo !== 'conversacion' && d.total === 0 && (d.resultados as unknown[])?.length === 0,
    traza: traza.map((p) => ({
      titulo: p.titulo,
      subtitulo: null,
      detalle: p.detalle,
      icono: ICONO_POR_PASO[String(p.paso)] ?? null,
      ms: p.ms,
    })),
  };
}

/**
 * Se descarta cualquier artículo sin los campos con los que se arma la ficha:
 * preferimos mostrar de menos que mostrar una ficha a medias.
 */
function articulosCompletos(lista: unknown): Articulo[] {
  return (Array.isArray(lista) ? (lista as Articulo[]) : [])
    .filter(
      (a) =>
        a &&
        typeof a.id === 'number' &&
        typeof a.url === 'string' &&
        typeof a.titulo === 'string' &&
        typeof a.fecha_pub === 'string',
    )
    .map((a) => ({
      ...a,
      autores: Array.isArray(a.autores) ? a.autores.filter((x) => typeof x === 'string') : [],
      numero: typeof a.numero === 'string' ? a.numero : null,
      seccion: typeof a.seccion === 'string' ? a.seccion : null,
      resumen_linea: typeof a.resumen_linea === 'string' ? a.resumen_linea : null,
    }));
}

/**
 * Valida la forma de la respuesta antes de renderizarla (sección 7, regla 5).
 * Si el backend cambia el contrato, se ve como un error tipado en pantalla,
 * no como una pantalla en blanco.
 */
function validarBuscar(crudo: unknown): RespuestaBuscar {
  const d = (
    crudo && typeof crudo === 'object' ? deFormaBackend(crudo as Record<string, unknown>) : crudo
  ) as Partial<RespuestaBuscar> | null;

  const modosValidos = ['panorama', 'hibrida', 'catalogo', 'conversacion'];
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
      JSON.stringify(crudo).slice(0, 400),
    );
  }

  const articulos = articulosCompletos(d.articulos);

  return {
    modo: d.modo as RespuestaBuscar['modo'],
    pregunta: typeof d.pregunta === 'string' ? d.pregunta : '',
    respuesta: typeof d.respuesta === 'string' ? d.respuesta : null,
    articulos,
    citadas: articulosCompletos(d.citadas),
    total: d.total ?? 0,
    pagina: typeof d.pagina === 'number' ? d.pagina : 1,
    por_pagina: typeof d.por_pagina === 'number' ? d.por_pagina : articulos.length,
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
    filtros: d.filtros ?? null,
    ms: typeof d.ms === 'number' ? d.ms : 0,
  };
}

export async function buscar(
  solicitud: SolicitudBuscar,
  senal?: AbortSignal,
): Promise<RespuestaBuscar> {
  return validarBuscar(await llamar<unknown>('buscar', solicitud, senal));
}

/** Lo que llega mientras Haiku escribe: vista previa, no la respuesta. */
export type EventoEnVivo =
  | { t: 'texto'; d: string }
  | { t: 'ficha'; f: Articulo }
  | { t: 'reinicio' };

/**
 * La misma consulta que `buscar`, pero el texto de la respuesta llega
 * conforme se escribe (Server-Sent Events con `?en_vivo=1`). Lo que se
 * devuelve es la respuesta completa y validada del evento `final`; lo
 * transmitido antes es solo vista previa.
 */
export async function buscarEnVivo(
  solicitud: SolicitudBuscar,
  senal: AbortSignal | undefined,
  alEvento: (e: EventoEnVivo) => void,
): Promise<RespuestaBuscar> {
  if (!URL_SUPABASE || !ANON_KEY) throw sinConfigurar();
  const token = await obtenerTokenSesion();

  let respuesta: Response;
  try {
    respuesta = await fetch(`${URL_SUPABASE}/functions/v1/buscar?en_vivo=1`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: ANON_KEY,
        authorization: `Bearer ${token ?? ANON_KEY}`,
      },
      body: JSON.stringify(solicitud),
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

  // Un error antes de empezar a transmitir (o una versión del backend sin
  // transmisión) llega como JSON normal.
  if (!(respuesta.headers.get('content-type') ?? '').includes('text/event-stream') || !respuesta.body) {
    const texto = await respuesta.text();
    let datos: unknown = null;
    try {
      datos = texto ? JSON.parse(texto) : null;
    } catch {
      throw new ErrorConsulta('respuesta_invalida', 'El archivo respondió algo que no se pudo leer.', texto.slice(0, 400));
    }
    if (!respuesta.ok) throw errorDeRespuesta(respuesta.status, respuesta.statusText, datos);
    return validarBuscar(datos);
  }

  const lector = respuesta.body.pipeThrough(new TextDecoderStream()).getReader();
  let pendiente = '';
  for (;;) {
    const { value, done } = await lector.read();
    if (done) break;
    pendiente += value;
    let corte: number;
    while ((corte = pendiente.indexOf('\n\n')) >= 0) {
      const bloque = pendiente.slice(0, corte);
      pendiente = pendiente.slice(corte + 2);
      const linea = bloque.split('\n').find((l) => l.startsWith('data: '));
      if (!linea) continue;
      let evento: { t?: string; d?: unknown; f?: unknown; estado?: number; cuerpo?: unknown };
      try {
        evento = JSON.parse(linea.slice(6));
      } catch {
        continue;
      }
      if (evento.t === 'final') {
        void lector.cancel().catch(() => {});
        const estado = typeof evento.estado === 'number' ? evento.estado : 200;
        if (estado >= 400) throw errorDeRespuesta(estado, '', evento.cuerpo);
        return validarBuscar(evento.cuerpo);
      }
      if (evento.t === 'texto' && typeof evento.d === 'string') alEvento({ t: 'texto', d: evento.d });
      else if (evento.t === 'reinicio') alEvento({ t: 'reinicio' });
      else if (evento.t === 'ficha') {
        const [f] = articulosCompletos([evento.f]);
        if (f) alEvento({ t: 'ficha', f });
      }
    }
  }
  throw new ErrorConsulta(
    'respuesta_cortada',
    'La respuesta se cortó antes de terminar. Vuelve a intentarlo.',
    'La transmisión terminó sin el evento final.',
  );
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

// --- Conversaciones de quien inició sesión -----------------------------------
// La Edge Function `conversaciones` valida el JWT y solo toca las filas de ese
// usuario. Sin sesión no se llama: las conversaciones viven en el navegador.

export interface ConversacionRemota {
  id: string;
  titulo: string;
  actualizada_en: string;
  turnos?: unknown[];
}

export async function listarConversaciones(): Promise<ConversacionRemota[]> {
  const d = await llamar<{ conversaciones?: ConversacionRemota[] }>('conversaciones', { accion: 'listar' });
  return Array.isArray(d.conversaciones) ? d.conversaciones : [];
}

export async function leerConversacion(id: string): Promise<ConversacionRemota | null> {
  const d = await llamar<{ conversacion?: ConversacionRemota | null }>('conversaciones', { accion: 'leer', id });
  return d.conversacion ?? null;
}

export async function guardarConversacionRemota(c: {
  id: string;
  titulo: string;
  turnos: unknown[];
  actualizada_en: number;
}): Promise<void> {
  await llamar('conversaciones', { accion: 'guardar', ...c });
}

export async function borrarConversacionRemota(id: string): Promise<void> {
  await llamar('conversaciones', { accion: 'borrar', id });
}

export async function importarConversaciones(
  conversaciones: { id: string; titulo: string; turnos: unknown[]; actualizada_en: number }[],
): Promise<void> {
  if (conversaciones.length === 0) return;
  await llamar('conversaciones', { accion: 'importar', conversaciones });
}
