// Vector de la PREGUNTA, para compararlo con el de cada artículo (migración
// 0006). Los vectores de los artículos los calcula `npm run embeber` con el
// mismo modelo y la misma dimensión; si no coinciden, la distancia no
// significa nada.
//
// Una sola petición por consulta, sin rotación de modelos: el cupo de
// embeddings es aparte del de generación, y un vector de otro modelo no se
// puede comparar con los guardados.

import { DIM_EMBEDDINGS, geminiApiKey, MODELO_EMBEDDINGS, TIMEOUT_EMBEDDING_MS } from './config.ts';
import { ErrorBuscar } from './errores.ts';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Las mismas preguntas se repiten (ejemplos de la home, reintentos). */
const CACHE = new Map<string, number[]>();
const CACHE_MAX = 200;

export async function embeberConsulta(texto: string): Promise<number[]> {
  const clave = texto.trim().toLowerCase();
  const enCache = CACHE.get(clave);
  if (enCache) return enCache;

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
        outputDimensionality: DIM_EMBEDDINGS,
      }),
      signal: AbortSignal.timeout(TIMEOUT_EMBEDDING_MS),
    });
  } catch (e) {
    const tiempo = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new ErrorBuscar(
      tiempo ? 'LLM_TIMEOUT' : 'LLM_ERROR',
      'La búsqueda por significado no respondió.',
      {
        detalle: `${MODELO_EMBEDDINGS}: ${
          tiempo ? `se agotaron ${TIMEOUT_EMBEDDING_MS} ms` : e instanceof Error ? e.message : String(e)
        }`,
      },
    );
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
  const valores = json.embedding?.values;
  if (
    !Array.isArray(valores) || valores.length !== DIM_EMBEDDINGS ||
    !valores.every((v) => typeof v === 'number' && Number.isFinite(v))
  ) {
    throw new ErrorBuscar('LLM_RESPUESTA_INVALIDA', 'La búsqueda por significado no respondió.', {
      detalle: `${MODELO_EMBEDDINGS}: se esperaba un vector de ${DIM_EMBEDDINGS} números.`,
    });
  }

  if (CACHE.size >= CACHE_MAX) CACHE.delete(CACHE.keys().next().value!);
  CACHE.set(clave, valores as number[]);
  return valores as number[];
}
