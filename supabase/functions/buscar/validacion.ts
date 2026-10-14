// Validación de todo lo que devuelve un LLM, ANTES de renderizarlo
// (CLAUDE.md sección 7, regla 5). Aquí no se confía en nada: ni en los tipos,
// ni en los rangos, ni en los ids.

import { ANIO_MAX, ANIO_MIN } from './config.ts';
import { ErrorBuscar } from './errores.ts';
import { contieneLiga, sanearParrafos, sanearTextoModelo } from './texto.ts';
import type { FiltrosAplicados, Modo } from './tipos.ts';

const MODOS: Modo[] = ['panorama', 'hibrida', 'catalogo'];

function esObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function invalido(detalle: string): ErrorBuscar {
  return new ErrorBuscar(
    'LLM_RESPUESTA_INVALIDA',
    'El modelo devolvió una respuesta que no cumple el esquema; se descartó.',
    { detalle },
  );
}

function cadenas(v: unknown, max: number, largoMax = 120): string[] {
  if (!Array.isArray(v)) return [];
  const salida: string[] = [];
  for (const bruto of v) {
    const s = sanearTextoModelo(bruto, largoMax);
    if (s.length > 0 && !salida.includes(s)) salida.push(s);
    if (salida.length >= max) break;
  }
  return salida;
}

function anios(v: unknown, max: number): number[] {
  if (!Array.isArray(v)) return [];
  const salida: number[] = [];
  for (const bruto of v) {
    const n = typeof bruto === 'number' ? bruto : Number.parseInt(String(bruto), 10);
    if (!Number.isInteger(n) || n < ANIO_MIN || n > ANIO_MAX) continue;
    if (!salida.includes(n)) salida.push(n);
    if (salida.length >= max) break;
  }
  return salida.sort((a, b) => a - b);
}

function anioOpcional(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number.parseInt(String(v), 10);
  if (!Number.isInteger(n) || n < ANIO_MIN || n > ANIO_MAX) return null;
  return n;
}

// --- Router -----------------------------------------------------------------

export interface ClasificacionCruda {
  modo: Modo;
  autores: string[];
  anio_pub_desde: number | null;
  anio_pub_hasta: number | null;
  anios_referidos: number[];
  temas: string[];
  razon: string;
}

/**
 * Esquema estricto del router. Nótese que todos los campos son obligatorios y
 * planos: `strict: true` exige `required` completo y `additionalProperties:false`,
 * y los objetos anidados nulables complican eso sin ganar nada.
 */
export const ESQUEMA_ROUTER = {
  type: 'object',
  additionalProperties: false,
  required: [
    'modo',
    'autores',
    'anio_pub_desde',
    'anio_pub_hasta',
    'anios_referidos',
    'temas',
    'razon',
  ],
  properties: {
    modo: {
      type: 'string',
      enum: ['panorama', 'hibrida', 'catalogo'],
      description:
        'catalogo: la pregunta es un filtro (autor, año, década, sección) y se responde con SQL. ' +
        'panorama: pide una visión de conjunto sobre un tema o una época. ' +
        'hibrida: busca textos concretos sobre un tema, con o sin filtros duros.',
    },
    autores: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Nombres de persona mencionados en la pregunta, tal cual los escribió quien pregunta. ' +
        'Arreglo vacío si no hay ninguno. No inventes autores ni completes nombres.',
    },
    anio_pub_desde: {
      type: ['integer', 'null'],
      description: 'Año inicial de PUBLICACIÓN si la pregunta lo acota. null si no.',
    },
    anio_pub_hasta: {
      type: ['integer', 'null'],
      description: 'Año final de PUBLICACIÓN si la pregunta lo acota. null si no.',
    },
    anios_referidos: {
      type: 'array',
      items: { type: 'integer' },
      description:
        'Años de los que HABLA el texto buscado (distinto del año de publicación). ' +
        '"lo que se ha escrito sobre el 2006" son anios_referidos, no publicación.',
    },
    temas: {
      type: 'array',
      items: { type: 'string' },
      description: 'Palabras clave temáticas de la pregunta. Vacío si la pregunta es solo un filtro.',
    },
    razon: {
      type: 'string',
      description: 'Una frase corta, en español, explicando por qué ese modo. Va a la traza.',
    },
  },
} as const;

export function validarClasificacion(crudo: unknown): ClasificacionCruda {
  if (!esObjeto(crudo)) throw invalido('La clasificación no es un objeto.');

  const modo = crudo.modo;
  if (typeof modo !== 'string' || !MODOS.includes(modo as Modo)) {
    throw invalido(`modo inválido: ${JSON.stringify(modo)}`);
  }

  const razon = sanearTextoModelo(crudo.razon, 200);

  return {
    modo: modo as Modo,
    autores: cadenas(crudo.autores, 3, 80),
    anio_pub_desde: anioOpcional(crudo.anio_pub_desde),
    anio_pub_hasta: anioOpcional(crudo.anio_pub_hasta),
    anios_referidos: anios(crudo.anios_referidos, 40),
    temas: cadenas(crudo.temas, 6, 60),
    razon: razon || 'sin explicación',
  };
}

// --- Seguimiento de conversación ---------------------------------------------

export interface SeguimientoCrudo {
  pregunta_resuelta: string;
  depende_del_anterior: boolean;
}

export const ESQUEMA_SEGUIMIENTO = {
  type: 'object',
  additionalProperties: false,
  required: ['pregunta_resuelta', 'depende_del_anterior'],
  properties: {
    pregunta_resuelta: {
      type: 'string',
      description:
        'La pregunta nueva reescrita como una consulta completa e independiente, incorporando ' +
        'solo lo que hace falta de la pregunta anterior (autor, año, tema). Si la pregunta nueva ' +
        'ya es independiente, se devuelve tal cual, sin inventar nada que no esté en ninguna de las dos.',
    },
    depende_del_anterior: {
      type: 'boolean',
      description: 'true solo si de verdad hacía falta la pregunta anterior para entender esta.',
    },
  },
} as const;

export function validarSeguimiento(crudo: unknown): SeguimientoCrudo {
  if (!esObjeto(crudo)) throw invalido('La reformulación no es un objeto.');
  return {
    pregunta_resuelta: sanearTextoModelo(crudo.pregunta_resuelta, 500),
    depende_del_anterior: crudo.depende_del_anterior === true,
  };
}

// --- Respuesta redactada (panorama e hibrida) -------------------------------
//
// Antes la síntesis era un párrafo de 2–4 frases SIN citas, más un arreglo de
// temáticas que la interfaz nunca enseña (solo pinta `sintesis.texto`). El
// editor veía un resumen genérico que no le decía qué texto decía qué. Ahora
// el texto cita con marcas `[id:N]`, que la interfaz convierte en el título
// REAL de la base con su liga (TextoRespuesta.tsx): el modelo sigue sin
// escribir títulos, solo señala ids.

export interface RespuestaCruda {
  texto: string;
  articulo_ids: number[];
}

export const ESQUEMA_RESPUESTA = {
  type: 'object',
  additionalProperties: false,
  required: ['texto', 'articulo_ids'],
  properties: {
    texto: {
      type: 'string',
      description:
        'La respuesta, en español de México, en párrafos separados por una línea en blanco. ' +
        'Cada vez que te refieras a un texto del archivo escribe su marca [id:N] (N = el id de la ficha) ' +
        'en lugar de su título. Prohibido escribir títulos, fechas o ligas.',
    },
    articulo_ids: {
      type: 'array',
      items: { type: 'integer' },
      description:
        'Ids de las fichas que de verdad responden la pregunta, de la más a la menos pertinente. ' +
        'Solo ids que aparezcan en la lista; nunca inventes uno. Vacío si ninguna responde.',
    },
  },
} as const;

const MARCA = /\[\s*id\s*[:=]?\s*(\d+)\s*\]/gi;

/**
 * Valida la respuesta y descarta todo id que no se le haya dado al modelo,
 * tanto en `articulo_ids` como en las marcas del texto (sección 7, regla 1).
 * Los ids citados en el texto cuentan como pertinentes aunque el modelo haya
 * olvidado listarlos: una cita sin ficha sería una cita rota.
 */
function escaparRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * El modelo a veces escribe el título aunque el prompt se lo prohíbe — visto
 * en producción: «en [id:9154], que se titula "Duelos y quebrantos", …» y
 * «evoca recuerdos de infancia con La manzana, el Nescafé y la Coca-Cola».
 * Un título escrito por el modelo es justo lo que la regla 1 de la sección 7
 * prohíbe, pero borrarlo deja frases truncas ("…de infancia con."). Como se
 * sabe a qué ficha pertenece cada título, se sustituye por su marca: la
 * interfaz pone el título REAL con su liga, y la frase queda completa. Si la
 * marca ya estaba al lado, el duplicado se funde.
 */
export function quitarTitulosEscritos(texto: string, fichas: { id: number; titulo: string }[]): string {
  let t = texto.replace(
    /,?\s*(?:que\s+)?(?:se\s+)?(?:titula(?:do|da)?|intitulad[oa]|llamad[oa])\s*[«"“'][^»"”'\n]{2,200}[»"”']/giu,
    '',
  );
  // Los títulos largos primero: uno puede contener a otro más corto.
  const ordenadas = [...fichas].sort((x, y) => y.titulo.length - x.titulo.length);
  for (const { id, titulo } of ordenadas) {
    const limpio = titulo.trim();
    if (limpio.length < 4) continue;
    const e = escaparRegex(limpio);
    // Entre comillas es una cita del título, sin duda.
    t = t.replace(new RegExp(`[«"“]${e}[»"”]`, 'giu'), `[id:${id}]`);
    // Sin comillas, solo si no puede ser una palabra normal: "Aforismos" es
    // título de un artículo y también una palabra que el modelo usa.
    if (limpio.length >= 12 && /\s/.test(limpio)) t = t.replace(new RegExp(e, 'giu'), `[id:${id}]`);
  }
  return t
    .replace(/\[id:(\d+)\](?:\s*[,;:]?\s*\[id:\1\])+/g, '[id:$1]')
    .replace(/[ \t]+([,.;:])/g, '$1')
    .replace(/,\s*,/g, ',')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

export function validarRespuesta(
  crudo: unknown,
  idsPermitidos: Set<number>,
  op: { exigirIds: boolean; maxIds: number; fichas?: { id: number; titulo: string }[] },
): RespuestaCruda {
  if (!esObjeto(crudo)) throw invalido('La respuesta no es un objeto.');

  let texto = sanearParrafos(crudo.texto, 3_500);
  if (contieneLiga(texto)) throw invalido('La respuesta trae una liga: el modelo no escribe URLs.');
  // Antes de leer las marcas: un título sustituido por su marca cuenta como cita.
  if (op.fichas && op.fichas.length > 0) texto = quitarTitulosEscritos(texto, op.fichas);

  const citados: number[] = [];
  texto = texto.replace(MARCA, (_m, n: string) => {
    const id = Number.parseInt(n, 10);
    if (!idsPermitidos.has(id)) return '';
    if (!citados.includes(id)) citados.push(id);
    return `[id:${id}]`;
  })
    .replace(/[ \t]+([,.;:])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ');

  if (texto.replace(MARCA, '').trim().length < 20) {
    throw invalido('La respuesta viene vacía o es demasiado corta.');
  }

  const ids: number[] = [];
  const brutos = Array.isArray(crudo.articulo_ids) ? crudo.articulo_ids : [];
  for (const bruto of [...brutos, ...citados]) {
    const n = typeof bruto === 'number' ? bruto : Number.parseInt(String(bruto), 10);
    if (Number.isInteger(n) && idsPermitidos.has(n) && !ids.includes(n)) ids.push(n);
    if (ids.length >= op.maxIds) break;
  }

  if (op.exigirIds && ids.length === 0) {
    throw invalido('La respuesta no quedó respaldada por ningún id real del archivo.');
  }

  return { texto, articulo_ids: ids };
}

// --- Eco de filtros para paginar --------------------------------------------

/**
 * Los filtros que la interfaz devuelve para pedir otra página. Vienen del
 * navegador, así que se validan como cualquier entrada: tipos, largos y
 * rangos. Son seguros en sí (solo alimentan un WHERE parametrizado con
 * service role), pero nada que no tenga la forma exacta pasa.
 */
export function validarFiltrosEco(crudo: unknown): FiltrosAplicados | null {
  if (!esObjeto(crudo)) return null;
  const texto = (v: unknown, max: number) =>
    typeof v === 'string' && v.trim() !== '' && v.length <= max ? v.trim() : null;
  const listaTexto = (v: unknown, maxItems: number, maxLargo: number) =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '' && x.length <= maxLargo)
        .slice(0, maxItems)
      : [];

  let aniosPub: FiltrosAplicados['anios_pub'] = null;
  if (esObjeto(crudo.anios_pub)) {
    const d = Number(crudo.anios_pub.desde);
    const h = Number(crudo.anios_pub.hasta);
    if (Number.isInteger(d) && Number.isInteger(h) && d >= ANIO_MIN && h <= ANIO_MAX && d <= h) {
      aniosPub = { desde: d, hasta: h };
    }
  }

  return {
    autores: listaTexto(crudo.autores, 5, 160),
    anios_pub: aniosPub,
    anios_referidos: anios(crudo.anios_referidos, 120),
    temas: listaTexto(crudo.temas, 10, 80),
    texto: texto(crudo.texto, 300),
    seccion: texto(crudo.seccion, 160),
  };
}
