// Vectores de los artículos con Gemini, para la búsqueda por significado
// (migración 0006). La Edge Function calcula el de la PREGUNTA con el mismo
// modelo y la misma dimensión (supabase/functions/buscar/embeddings.ts): si
// alguno de los dos cambia, hay que rehacer todos los vectores.
import './red.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export const MODELO_EMBEDDINGS = process.env.MODELO_EMBEDDINGS ?? 'gemini-embedding-001';
export const DIM_EMBEDDINGS = 768;
/** Tope de la API por petición de batchEmbedContents. */
export const MAX_POR_PETICION = 100;

export interface ArticuloParaVector {
  id: number;
  titulo: string;
  autores: string[] | null;
  seccion: string | null;
  temas: string[] | null;
  resumen_linea: string | null;
}

/**
 * De qué está hecho el vector: lo que dice de qué trata el artículo. Ni fecha
 * ni número de revista: eso son filtros duros, no significado, y meterlos
 * acercaría artículos por haber salido el mismo mes.
 */
export function textoParaVector(a: ArticuloParaVector): string {
  const lineas = [a.titulo.trim()];
  const autores = (a.autores ?? []).filter((x) => x && x.trim() !== '');
  if (autores.length > 0) lineas.push(`Autor: ${autores.join(', ')}`);
  if (a.seccion) lineas.push(`Sección: ${a.seccion}`);
  const temas = (a.temas ?? []).filter((t) => t && t.trim() !== '');
  if (temas.length > 0) lineas.push(`Temas: ${temas.join(', ')}`);
  if (a.resumen_linea) lineas.push(a.resumen_linea.trim());
  return lineas.join('\n');
}

export interface ErrorEmbeddings extends Error {
  status?: number;
  /** Cuota del DÍA: esperar un minuto no la arregla. */
  cuotaDiaria?: boolean;
  fatal?: boolean;
}

/** Una petición de hasta 100 textos. Devuelve un vector por texto, en orden. */
export async function embeberLote(
  textos: { texto: string; titulo: string }[],
): Promise<number[][]> {
  const llave = process.env.GEMINI_API_KEY;
  if (!llave) {
    const err: ErrorEmbeddings = new Error('Falta GEMINI_API_KEY en el entorno (ver .env.example).');
    err.fatal = true;
    throw err;
  }

  const res = await fetch(`${BASE}/${MODELO_EMBEDDINGS}:batchEmbedContents`, {
    method: 'POST',
    headers: { 'x-goog-api-key': llave, 'content-type': 'application/json' },
    body: JSON.stringify({
      requests: textos.map((t) => ({
        model: `models/${MODELO_EMBEDDINGS}`,
        content: { parts: [{ text: t.texto }] },
        // Documento contra pregunta: la Edge Function usa RETRIEVAL_QUERY.
        taskType: 'RETRIEVAL_DOCUMENT',
        title: t.titulo,
        outputDimensionality: DIM_EMBEDDINGS,
      })),
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!res.ok) {
    const cuerpo = (await res.text().catch(() => '')).slice(0, 500);
    const err: ErrorEmbeddings = new Error(`HTTP ${res.status}: ${cuerpo}`);
    err.status = res.status;
    // El 429 de cuota diaria de embeddings NO dice "per day" (medido
    // 2026-10-14): dice `embed_content_free_tier_requests, limit: 1000` y
    // "Please retry in 20h25m…". La señal inequívoca es una espera de horas
    // (el de por minuto pide segundos); `free_tier_requests` no sirve porque
    // puede aparecer también en el de por minuto.
    const esperaHoras = /retry in (\d+)h/i.exec(cuerpo);
    err.cuotaDiaria = res.status === 429 && (
      /per\s*day|PerDay/i.test(cuerpo) ||
      (esperaHoras !== null && Number(esperaHoras[1]) >= 1)
    );
    err.fatal = res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404;
    throw err;
  }

  const json = (await res.json()) as { embeddings?: { values?: number[] }[] };
  const vectores = (json.embeddings ?? []).map((e) => e.values ?? []);
  if (vectores.length !== textos.length || vectores.some((v) => v.length !== DIM_EMBEDDINGS)) {
    const err: ErrorEmbeddings = new Error(
      `Respuesta inesperada: ${vectores.length} vectores para ${textos.length} textos, ` +
        `se esperaban ${DIM_EMBEDDINGS} dimensiones.`,
    );
    err.fatal = true;
    throw err;
  }
  return vectores;
}
