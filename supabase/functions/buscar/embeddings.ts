// Vector de la PREGUNTA, para compararlo con el de cada artículo (migración
// 0006). Los vectores de los artículos los calcula `npm run embeber` con el
// mismo modelo y la misma dimensión; si no coinciden, la distancia no
// significa nada.
//
// Una sola petición por consulta, sin rotación de modelos: el cupo de
// embeddings es aparte del de generación, y un vector de otro modelo no se
// puede comparar con los guardados.

import {
  dimEmbeddings,
  geminiApiKey,
  MODELO_EMBEDDINGS,
  MODELO_VOYAGE,
  TIMEOUT_EMBEDDING_MS,
  usaVoyage,
  voyageApiKey,
} from './config.ts';
import { ErrorBuscar } from './errores.ts';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Las mismas preguntas se repiten (ejemplos de la home, reintentos). */
const CACHE = new Map<string, number[]>();
const CACHE_MAX = 200;

export async function embeberConsulta(texto: string): Promise<number[]> {
  const clave = `${usaVoyage() ? 'v' : 'g'}:${texto.trim().toLowerCase()}`;
  const enCache = CACHE.get(clave);
  if (enCache) return enCache;
  const valores = usaVoyage() ? await conVoyage(texto) : await conGemini(texto);
  if (CACHE.size >= CACHE_MAX) CACHE.delete(CACHE.keys().next().value!);
  CACHE.set(clave, valores);
  return valores;
}

function vectorValido(valores: unknown, modelo: string): number[] {
  const dim = dimEmbeddings();
  if (
    !Array.isArray(valores) || valores.length !== dim ||
    !valores.every((v) => typeof v === 'number' && Number.isFinite(v))
  ) {
    throw new ErrorBuscar('LLM_RESPUESTA_INVALIDA', 'La búsqueda por significado no respondió.', {
      detalle: `${modelo}: se esperaba un vector de ${dim} números.`,
    });
  }
  return valores as number[];
}

function errorDeRed(e: unknown, modelo: string): ErrorBuscar {
  const tiempo = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
  return new ErrorBuscar(
    tiempo ? 'LLM_TIMEOUT' : 'LLM_ERROR',
    'La búsqueda por significado no respondió.',
    {
      detalle: `${modelo}: ${
        tiempo ? `se agotaron ${TIMEOUT_EMBEDDING_MS} ms` : e instanceof Error ? e.message : String(e)
      }`,
    },
  );
}

/** Voyage AI (`voyage-4`): `input_type: 'query'` contra los artículos, que
 *  se cargan con `'document'` (scripts/lib/embeddings.ts). */
async function conVoyage(texto: string): Promise<number[]> {
  let res: Response;
  try {
    res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: { authorization: `Bearer ${voyageApiKey()}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        input: [texto],
        model: MODELO_VOYAGE,
        input_type: 'query',
        output_dimension: dimEmbeddings(),
      }),
      signal: AbortSignal.timeout(TIMEOUT_EMBEDDING_MS),
    });
  } catch (e) {
    throw errorDeRed(e, MODELO_VOYAGE);
  }
  if (!res.ok) {
    const cuerpo = (await res.text().catch(() => '')).slice(0, 300);
    throw new ErrorBuscar(
      res.status === 429 ? 'LLM_LIMITE' : 'LLM_ERROR',
      'La búsqueda por significado no respondió.',
      { detalle: `${MODELO_VOYAGE}: HTTP ${res.status}: ${cuerpo}` },
    );
  }
  const json = (await res.json()) as { data?: { embedding?: unknown }[] };
  return vectorValido(json.data?.[0]?.embedding, MODELO_VOYAGE);
}

async function conGemini(texto: string): Promise<number[]> {
  const llave = geminiApiKey();
  if (!llave) {
    throw new ErrorBuscar('LLM_SIN_LLAVE', 'La búsqueda por significado no está disponible.', {
      detalle: 'GEMINI_API_KEY no está definida en los secrets de la función.',
    });
  }

  let res: Response;
  try {
    res = await fetch(`${BASE}/${MODELO_EMBEDDINGS}:embedContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': llave, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: `models/${MODELO_EMBEDDINGS}`,
        content: { parts: [{ text: texto }] },
        // Pregunta corta contra documentos largos: el modelo los proyecta
        // distinto a propósito (los artículos van con RETRIEVAL_DOCUMENT).
        taskType: 'RETRIEVAL_QUERY',
        outputDimensionality: dimEmbeddings(),
      }),
      signal: AbortSignal.timeout(TIMEOUT_EMBEDDING_MS),
    });
  } catch (e) {
    throw errorDeRed(e, MODELO_EMBEDDINGS);
  }

  if (!res.ok) {
    const cuerpo = (await res.text().catch(() => '')).slice(0, 300);
    throw new ErrorBuscar(
      res.status === 429 ? 'LLM_LIMITE' : 'LLM_ERROR',
      'La búsqueda por significado no respondió.',
      { detalle: `${MODELO_EMBEDDINGS}: HTTP ${res.status}: ${cuerpo}` },
    );
  }

  const json = (await res.json()) as { embedding?: { values?: unknown } };
  return vectorValido(json.embedding?.values, MODELO_EMBEDDINGS);
}
