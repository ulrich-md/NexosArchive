// Cliente de Gemini para los scripts de Node.
//
// Se usa la API REST directa en vez del SDK: la superficie que necesitamos es
// una sola llamada con salida estructurada, y así no se añade otra dependencia
// que mantener.
//
// Todo lo de aquí está verificado contra la API real el 2026-09-07 con el
// prompt y el esquema reales del enriquecimiento.
import './red.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** CLAUDE.md §8 quedó desactualizada: el proyecto usa Gemini, no Claude. */
export const MODELO_POR_DEFECTO = 'gemini-2.5-flash';

export interface UsoGemini {
  entrada: number;
  salida: number;
  pensamiento: number;
  cacheado: number;
}

export interface RespuestaGemini {
  bruto: unknown;
  uso: UsoGemini;
  truncada: boolean;
}

export interface ErrorGemini extends Error {
  status?: number;
  fatal?: boolean;
}

/**
 * `responseSchema` acepta un subconjunto de OpenAPI, NO JSON Schema completo:
 * con `additionalProperties` (que el modo estricto de Anthropic sí exige) la
 * petición falla con 400. Se quitan las palabras clave no soportadas.
 */
export function aEsquemaGemini(nodo: unknown): unknown {
  if (Array.isArray(nodo)) return nodo.map(aEsquemaGemini);
  if (!nodo || typeof nodo !== 'object') return nodo;

  const fuera = new Set(['additionalProperties', '$schema', 'strict', 'default', 'examples', 'title']);
  const salida: Record<string, unknown> = {};
  for (const [clave, valor] of Object.entries(nodo as Record<string, unknown>)) {
    if (!fuera.has(clave)) salida[clave] = aEsquemaGemini(valor);
  }
  return salida;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface OpcionesGemini {
  modelo: string;
  systemPrompt: string;
  mensaje: string;
  esquema: unknown;
  maxTokens: number;
  /** Los modelos 2.5 traen "thinking" encendido y esos tokens se cobran como
   *  salida: medido, 552 tokens de razonamiento sobre una respuesta de 360.
   *  Para extracción masiva no aporta nada. */
  pensar?: boolean;
  maxReintentos?: number;
  alReintentar?: (status: number | string, intento: number, esperaMs: number) => void;
}

/** Una llamada con salida estructurada, con reintento y backoff en 429/5xx. */
export async function llamarGemini(op: OpcionesGemini): Promise<RespuestaGemini> {
  const llave = process.env.GEMINI_API_KEY;
  if (!llave) {
    const err: ErrorGemini = new Error('Falta GEMINI_API_KEY en el entorno (ver .env.example).');
    err.fatal = true;
    throw err;
  }

  const maxReintentos = op.maxReintentos ?? 6;
  const cuerpo = {
    systemInstruction: { parts: [{ text: op.systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: op.mensaje }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: aEsquemaGemini(op.esquema),
      temperature: 0,
      maxOutputTokens: op.maxTokens,
      ...(op.pensar ? {} : { thinkingConfig: { thinkingBudget: 0 } }),
    },
  };

  let intento = 0;
  for (;;) {
    const res = await fetch(`${BASE}/${op.modelo}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': llave, 'content-type': 'application/json' },
      body: JSON.stringify(cuerpo),
    }).catch(() => null);

    if (res?.ok) {
      const json = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
        usageMetadata?: Record<string, number>;
      };
      const candidato = json.candidates?.[0];
      const texto = (candidato?.content?.parts ?? []).map((p) => p.text ?? '').join('');
      const u = json.usageMetadata ?? {};

      let bruto: unknown = null;
      try {
        bruto = texto ? JSON.parse(texto) : null;
      } catch {
        bruto = null; // el validador de arriba lo tratará como lote perdido
      }

      return {
        bruto,
        uso: {
          entrada: u.promptTokenCount ?? 0,
          salida: u.candidatesTokenCount ?? 0,
          pensamiento: u.thoughtsTokenCount ?? 0,
          cacheado: u.cachedContentTokenCount ?? 0,
        },
        truncada: candidato?.finishReason === 'MAX_TOKENS',
      };
    }

    // 400 con la llave mala, 401 y 403 no se reintentan: quemarían tiempo.
    if (res && (res.status === 401 || res.status === 403)) {
      const err: ErrorGemini = new Error(`Gemini rechazó la credencial (HTTP ${res.status}). Revisa GEMINI_API_KEY.`);
      err.status = res.status;
      err.fatal = true;
      throw err;
    }

    const reintentable = !res || res.status === 429 || res.status >= 500;
    if (!reintentable || intento >= maxReintentos) {
      const detalle = res ? `${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}` : 'error de red';
      const err: ErrorGemini = new Error(`Gemini falló (${detalle})`);
      err.status = res?.status;
      throw err;
    }

    const espera = Math.min(60_000, 1_000 * 2 ** intento) + Math.random() * 500;
    op.alReintentar?.(res?.status ?? 'red', intento + 1, espera);
    await sleep(espera);
    intento++;
  }
}
