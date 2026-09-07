// Contrato público de la Edge Function `buscar`.
// Este archivo es la única fuente de verdad de lo que la UI puede esperar.
// Todo lo que sale de aquí está en español de México: el copy de los mensajes
// de error es producto, no depuración (CLAUDE.md, encabezado y sección 0).

export const VERSION_CONTRATO = 1;

/** Los tres carriles de CLAUDE.md sección 4. */
export type Modo = 'panorama' | 'hibrida' | 'catalogo';

/**
 * Códigos de error. La UI puede reaccionar al código; el `mensaje` es lo que
 * se le enseña al editor. Nunca se devuelve un error sin código: el bug más
 * grave de la versión de Lovable era fallar en silencio (CLAUDE.md sección 0).
 */
export type CodigoError =
  | 'METODO_NO_PERMITIDO'
  | 'CUERPO_INVALIDO'
  | 'PREGUNTA_VACIA'
  | 'PREGUNTA_MUY_LARGA'
  | 'MODO_INVALIDO'
  | 'NO_AUTENTICADO'
  | 'DOMINIO_NO_AUTORIZADO'
  | 'SESION_REQUERIDA'
  | 'LIMITE_EXCEDIDO'
  | 'ARCHIVO_VACIO'
  | 'CONFIG_FALTANTE'
  | 'BD_ERROR'
  | 'LLM_SIN_LLAVE'
  | 'LLM_TIMEOUT'
  | 'LLM_LIMITE'
  | 'LLM_RECHAZO'
  | 'LLM_RESPUESTA_INVALIDA'
  | 'LLM_ERROR'
  | 'FASE2_INACTIVA'
  | 'FASE2_INCOMPLETA'
  | 'TIEMPO_AGOTADO'
  | 'ERROR_INTERNO';

export interface ErrorSerializado {
  codigo: CodigoError;
  /** Texto listo para enseñarse tal cual en la interfaz. */
  mensaje: string;
  /** Detalle técnico opcional (va al panel de traza, no al copy principal). */
  detalle?: string;
  /** Qué puede hacer el editor a continuación. */
  sugerencia?: string;
  /** Liga sugerida (por ejemplo `/admin` cuando el archivo está vacío). */
  liga?: string;
  /** Segundos que faltan para poder reintentar (solo LIMITE_EXCEDIDO). */
  reintentar_en_s?: number;
}

/**
 * Aviso no fatal: la consulta sí respondió, pero hay algo que el editor debe
 * saber (autor no encontrado, síntesis no disponible, enriquecimiento pendiente).
 * Se muestran, no se esconden.
 */
export interface Aviso {
  codigo: string;
  mensaje: string;
  detalle?: string;
}

/**
 * Ficha de artículo. La arma SIEMPRE la aplicación desde la base de datos.
 * El modelo jamás escribe ninguno de estos campos (CLAUDE.md sección 7, regla 1).
 */
export interface Ficha {
  id: number;
  titulo: string;
  url: string;
  autores: string[];
  /** `autor no consignado` cuando el archivo no trae autor. Jamás se deduce. */
  autor_etiqueta: string;
  autor_consignado: boolean;
  autor_confianza: string;
  fecha_pub: string;
  anio_pub: number | null;
  numero: string | null;
  seccion: string | null;
  resumen_linea: string | null;
}

/** Un paso de la traza de recuperación (CLAUDE.md sección 3, mejora 3). */
export interface PasoTraza {
  paso: 'router' | 'sql' | 'sintesis' | 'rerank' | 'degradacion' | 'aproximacion';
  titulo: string;
  detalle: string;
  ms: number;
}

/** Filtros que de verdad se aplicaron (no los que el modelo propuso). */
export interface FiltrosAplicados {
  autores: string[];
  anios_pub: { desde: number; hasta: number } | null;
  anios_referidos: number[];
  temas: string[];
  texto: string | null;
  seccion: string | null;
}

export interface Tematica {
  titulo: string;
  descripcion: string;
  articulo_ids: number[];
}

export interface Sintesis {
  texto: string;
  temas: Tematica[];
  /** Cuántas fichas se le dieron al modelo para agrupar. */
  fichas_consideradas: number;
  modelo: string;
}

export interface RespuestaOk {
  ok: true;
  version: number;
  modo: Modo;
  /** Modo que se pidió o se clasificó, si terminó sirviéndose por otro carril. */
  modo_solicitado: Modo | null;
  degradado: {
    desde: Modo;
    a: Modo;
    codigo: CodigoError;
    mensaje: string;
  } | null;
  pregunta: string;
  filtros: FiltrosAplicados;
  sintesis: Sintesis | null;
  resultados: Ficha[];
  /** Total de coincidencias en la base, no el largo de `resultados`. */
  total: number;
  pagina: number;
  por_pagina: number;
  /**
   * true cuando no hubo coincidencias exactas y se devolvieron los más
   * próximos (CLAUDE.md sección 7, regla 3). Nunca se devuelve vacío a secas.
   */
  aproximados: boolean;
  /** Reformulación concreta, construida con los filtros reales. */
  reformulacion: string | null;
  avisos: Aviso[];
  traza: PasoTraza[];
  ms: number;
}

export interface RespuestaError {
  ok: false;
  version: number;
  error: ErrorSerializado;
  avisos: Aviso[];
  traza: PasoTraza[];
  ms: number;
}

export type Respuesta = RespuestaOk | RespuestaError;

/** Fila de `articulos` tal como la devuelve la base (columnas seleccionadas). */
export interface FilaArticulo {
  id: number;
  url: string;
  titulo: string;
  autores: string[] | null;
  autor_confianza: string | null;
  fecha_pub: string;
  anio_pub: number | null;
  numero: string | null;
  seccion: string | null;
  resumen_linea: string | null;
}

export const COLUMNAS_ARTICULO =
  'id,url,titulo,autores,autor_confianza,fecha_pub,anio_pub,numero,seccion,resumen_linea';

/** Petición que acepta la función. */
export interface Peticion {
  pregunta: string;
  /** Los chips de la UI: `Panorama` · `Buscar` (hibrida) · `Catálogo`. */
  modo?: Modo;
  pagina?: number;
  por_pagina?: number;
}
