// Validación de todo lo que devuelve un LLM, ANTES de renderizarlo
// (CLAUDE.md sección 7, regla 5). Aquí no se confía en nada: ni en los tipos,
// ni en los rangos, ni en los ids.

import { ANIO_MAX, ANIO_MIN } from './config.ts';
import { ErrorBuscar } from './errores.ts';
import { contieneLiga, sanearTextoModelo } from './texto.ts';
import type { Modo, Tematica } from './tipos.ts';

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

// --- Síntesis del modo panorama ---------------------------------------------

export interface SintesisCruda {
  texto: string;
  temas: Tematica[];
}

export const ESQUEMA_SINTESIS = {
  type: 'object',
  additionalProperties: false,
  required: ['sintesis', 'temas'],
  properties: {
    sintesis: {
      type: 'string',
      description:
        'De dos a cuatro frases, en español de México, describiendo qué hay en el conjunto. ' +
        'Prohibido escribir títulos, nombres de autor, fechas o ligas: para eso están los ids.',
    },
    temas: {
      type: 'array',
      minItems: 3,
      maxItems: 6,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['titulo', 'descripcion', 'articulo_ids'],
        properties: {
          titulo: { type: 'string', description: 'Nombre corto de la temática.' },
          descripcion: {
            type: 'string',
            description: 'Una o dos frases sobre qué agrupa esta temática.',
          },
          articulo_ids: {
            type: 'array',
            items: { type: 'integer' },
            description:
              'Ids EXACTOS de los artículos de la lista que pertenecen a esta temática. ' +
              'Solo ids que aparezcan en la lista; nunca inventes uno.',
          },
        },
      },
    },
  },
} as const;

/**
 * Valida la síntesis y descarta todo id que no exista entre los que se le
 * dieron al modelo. Si al final no queda ninguna temática con respaldo real,
 * la respuesta se descarta entera (sección 7, regla 1).
 */
export function validarSintesis(crudo: unknown, idsPermitidos: Set<number>): SintesisCruda {
  if (!esObjeto(crudo)) throw invalido('La síntesis no es un objeto.');

  const texto = sanearTextoModelo(crudo.sintesis, 900);
  if (texto.length < 20) throw invalido('La síntesis viene vacía o es demasiado corta.');
  if (contieneLiga(texto)) throw invalido('La síntesis trae una liga: el modelo no escribe URLs.');

  if (!Array.isArray(crudo.temas)) throw invalido('temas no es un arreglo.');

  const temas: Tematica[] = [];
  for (const bruto of crudo.temas) {
    if (!esObjeto(bruto)) continue;
    const titulo = sanearTextoModelo(bruto.titulo, 80);
    const descripcion = sanearTextoModelo(bruto.descripcion, 400);
    if (titulo.length < 2) continue;
    if (contieneLiga(titulo) || contieneLiga(descripcion)) continue;

    const ids: number[] = [];
    if (Array.isArray(bruto.articulo_ids)) {
      for (const idBruto of bruto.articulo_ids) {
        const n = typeof idBruto === 'number' ? idBruto : Number.parseInt(String(idBruto), 10);
        if (Number.isInteger(n) && idsPermitidos.has(n) && !ids.includes(n)) ids.push(n);
        if (ids.length >= 20) break;
      }
    }
    // Una temática sin un solo artículo real no se enseña: sería una afirmación
    // sin respaldo en el archivo.
    if (ids.length === 0) continue;

    temas.push({ titulo, descripcion, articulo_ids: ids });
    if (temas.length >= 6) break;
  }

  if (temas.length === 0) {
    throw invalido('Ninguna temática quedó respaldada por ids reales del archivo.');
  }

  return { texto, temas };
}

// --- Rerank de la fase 2 ----------------------------------------------------

export const ESQUEMA_RERANK = {
  type: 'object',
  additionalProperties: false,
  required: ['ids'],
  properties: {
    ids: {
      type: 'array',
      items: { type: 'integer' },
      description:
        'Los ids de artículo más pertinentes, del más al menos pertinente. ' +
        'Solo ids de la lista dada; nunca inventes uno.',
    },
  },
} as const;

export function validarRerank(crudo: unknown, idsPermitidos: Set<number>, max: number): number[] {
  if (!esObjeto(crudo)) throw invalido('El rerank no es un objeto.');
  if (!Array.isArray(crudo.ids)) throw invalido('El rerank no trae ids.');
  const salida: number[] = [];
  for (const bruto of crudo.ids) {
    const n = typeof bruto === 'number' ? bruto : Number.parseInt(String(bruto), 10);
    if (Number.isInteger(n) && idsPermitidos.has(n) && !salida.includes(n)) salida.push(n);
    if (salida.length >= max) break;
  }
  if (salida.length === 0) throw invalido('El rerank no devolvió ningún id válido.');
  return salida;
}
