/**
 * CONTRATO con el backend (Edge Functions de Supabase).
 *
 * Este archivo es la única fuente de verdad de lo que el frontend espera
 * recibir. No describe cómo está implementada la Edge Function `buscar`
 * —eso es asunto suyo— sino la forma exacta del JSON que cruza la frontera.
 *
 * Reglas que este contrato hace cumplir (CLAUDE.md secciones 6 y 7):
 *
 *  - El frontend NUNCA lee tablas. Prohibido `supabase.from('articulos')`.
 *    Toda lectura del archivo pasa por una Edge Function con service role.
 *    Ver `web/scripts/verificar-seguridad.mjs`, que falla el build si
 *    aparece un acceso directo a tablas.
 *
 *  - El modelo NUNCA escribe títulos, autores, fechas ni URLs. Devuelve
 *    ids; la ficha se arma con los objetos `Articulo` que vienen en
 *    `articulos`. Por eso `respuesta` es texto con marcas `[id:123]` y no
 *    HTML: el frontend resuelve cada marca contra `articulos` y descarta
 *    en silencio la que apunte a un id inexistente.
 *
 *  - Todo error del backend es un error TIPADO que la interfaz muestra.
 *    Nada de fallas silenciosas.
 */

/** Los tres carriles de la sección 4. */
export type Modo = 'panorama' | 'hibrida' | 'catalogo';

/** Iconos permitidos en un paso de la traza. El frontend los mapea a
 *  `lucide-react`; un valor desconocido cae en un icono genérico. */
export type IconoTraza =
  | 'interpretacion'
  | 'consulta'
  | 'filtro'
  | 'orden'
  | 'lectura'
  | 'redaccion';

/** Ficha de un artículo. Todos los campos vienen de la base, ninguno del LLM. */
export interface Articulo {
  /** id de WordPress. Es la llave con la que se resuelven las marcas [id:N]. */
  id: number;
  /** Liga absoluta a nexos.com.mx. */
  url: string;
  titulo: string;
  /** Vacío ⇒ la ficha muestra `autor no consignado`. Jamás se deduce. */
  autores: string[];
  /** ISO `AAAA-MM-DD`. */
  fecha_pub: string;
  /** Número de la revista, p. ej. "1988 Enero". */
  numero: string | null;
  seccion: string | null;
  /** Una línea; habilita el modo panorama. Puede faltar si no hay enriquecimiento. */
  resumen_linea: string | null;
}

/** Un paso de la traza de recuperación (mejora 3 de la sección 3). */
export interface PasoTraza {
  titulo: string;
  subtitulo: string | null;
  /** Detalle expandible, en mono. SQL, filtros, conteos: lo que sea auditable. */
  detalle: string | null;
  icono: IconoTraza | null;
  ms: number | null;
}

/** Lo que el frontend manda a `POST /functions/v1/buscar`. */
export interface SolicitudBuscar {
  pregunta: string;
  /**
   * Carril sugerido por los chips. Es una SUGERENCIA: el router del backend
   * puede elegir otro, y la respuesta declara en `modo` cuál usó de verdad.
   * Así el frontend no se acopla a la lógica del router.
   */
  modo?: Modo;
  pagina?: number;
  por_pagina?: number;
}

export interface RespuestaBuscar {
  /** El carril que el backend usó realmente. Se muestra en la traza. */
  modo: Modo;
  /** Eco de la pregunta, para que la burbuja muestre lo que el backend entendió. */
  pregunta: string;
  /**
   * Texto redactado, con marcas `[id:123]` donde va una cita. `null` en modo
   * catálogo, que no llama al LLM. Nunca se renderiza como HTML.
   */
  respuesta: string | null;
  articulos: Articulo[];
  /** Total de coincidencias en la base, no la longitud de `articulos`. */
  total: number;
  traza: PasoTraza[];
  /** true ⇒ no hubo coincidencia exacta y esto es lo más cercano (regla 3). */
  aproximados: boolean;
  /** Reformulación concreta que se ofrece cuando `aproximados` es true. */
  sugerencia: string | null;
  /** true ⇒ la ingesta no ha corrido. La UI manda a /admin, no inventa datos. */
  archivo_vacio: boolean;
  ms: number;
}

/** Faceta del sidebar: nombre + conteo. Sale de la vista materializada. */
export interface Faceta {
  nombre: string;
  n: number;
}

/** `POST /functions/v1/facetas` — alimenta el sidebar en < 1 s. */
export interface RespuestaFacetas {
  autores: Faceta[];
  secciones: Faceta[];
  decadas: Faceta[];
  /** Totales reales del archivo sincronizado, para el subtítulo. */
  total_articulos: number;
  anio_min: number | null;
  anio_max: number | null;
}

/** Error tipado. Toda Edge Function devuelve esto con status >= 400. */
export interface ErrorApi {
  error: {
    codigo: string;
    mensaje: string;
    detalle?: string;
  };
}
