// Errores tipados. Regla dura de CLAUDE.md (sección 0 y sección 3, mejora 1):
// toda falla llega a la UI con un código y un mensaje en español; nunca un 500
// mudo, nunca un input que se vacía sin decir qué pasó.

import type { CodigoError, ErrorSerializado } from './tipos.ts';

interface Opciones {
  detalle?: string;
  sugerencia?: string;
  liga?: string;
  reintentar_en_s?: number;
  causa?: unknown;
}

export class ErrorBuscar extends Error {
  readonly codigo: CodigoError;
  readonly estado: number;
  readonly detalle?: string;
  readonly sugerencia?: string;
  readonly liga?: string;
  readonly reintentar_en_s?: number;
  readonly causa?: unknown;

  constructor(codigo: CodigoError, mensaje: string, opciones: Opciones = {}) {
    super(mensaje);
    this.name = 'ErrorBuscar';
    this.codigo = codigo;
    this.estado = ESTADO_HTTP[codigo] ?? 500;
    this.detalle = opciones.detalle;
    this.sugerencia = opciones.sugerencia;
    this.liga = opciones.liga;
    this.reintentar_en_s = opciones.reintentar_en_s;
    this.causa = opciones.causa;
  }

  serializar(): ErrorSerializado {
    return {
      codigo: this.codigo,
      mensaje: this.message,
      ...(this.detalle ? { detalle: this.detalle } : {}),
      ...(this.sugerencia ? { sugerencia: this.sugerencia } : {}),
      ...(this.liga ? { liga: this.liga } : {}),
      ...(this.reintentar_en_s !== undefined ? { reintentar_en_s: this.reintentar_en_s } : {}),
    };
  }
}

const ESTADO_HTTP: Record<CodigoError, number> = {
  METODO_NO_PERMITIDO: 405,
  CUERPO_INVALIDO: 400,
  PREGUNTA_VACIA: 400,
  PREGUNTA_MUY_LARGA: 400,
  MODO_INVALIDO: 400,
  NO_AUTENTICADO: 401,
  DOMINIO_NO_AUTORIZADO: 403,
  SESION_REQUERIDA: 401,
  LIMITE_EXCEDIDO: 429,
  ARCHIVO_VACIO: 503,
  CONFIG_FALTANTE: 500,
  BD_ERROR: 502,
  LLM_SIN_LLAVE: 500,
  LLM_TIMEOUT: 504,
  LLM_LIMITE: 429,
  LLM_RECHAZO: 502,
  LLM_RESPUESTA_INVALIDA: 502,
  LLM_ERROR: 502,
  FASE2_INACTIVA: 501,
  FASE2_INCOMPLETA: 501,
  TIEMPO_AGOTADO: 504,
  ERROR_INTERNO: 500,
};

/** Convierte cualquier excepción en un ErrorBuscar, sin perder el rastro. */
export function comoErrorBuscar(e: unknown): ErrorBuscar {
  if (e instanceof ErrorBuscar) return e;
  const detalle = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return new ErrorBuscar(
    'ERROR_INTERNO',
    'Algo falló al consultar el archivo. Vuelve a intentarlo.',
    { detalle, causa: e },
  );
}

/** Errores de PostgREST/Supabase con contexto de qué se estaba consultando. */
export function errorBd(donde: string, e: unknown): ErrorBuscar {
  const detalle = typeof e === 'object' && e !== null && 'message' in e
    ? String((e as { message: unknown }).message)
    : String(e);
  return new ErrorBuscar(
    'BD_ERROR',
    'No se pudo leer el archivo. Es una falla de la base de datos, no de tu consulta.',
    { detalle: `${donde}: ${detalle}`, sugerencia: 'Reintenta en unos segundos.', causa: e },
  );
}
