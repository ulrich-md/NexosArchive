// Llamadas a la API de Gemini.
//
// Sustituye a claude.ts (el dueño del proyecto cambió de proveedor por costo)
// conservando la MISMA interfaz, para que router.ts y los carriles solo cambien
// el import. Las dos reglas que gobiernan el archivo no cambian con el
// proveedor:
//   1. El modelo SIEMPRE responde contra un esquema, y su salida se valida
//      antes de renderizarse (CLAUDE.md sección 7, regla 5). En Gemini el
//      equivalente al forced tool-use de Anthropic es responseSchema +
//      responseMimeType: 'application/json'.
//   2. El texto del archivo que entra al prompt es DATO, nunca instrucción.
//
// Se usa la API REST directa en vez del SDK: la superficie que necesitamos es
// una sola llamada, y así no se añade otra dependencia al bundle de la función.
//
// Verificado contra la API real el 2026-09-07 con el esquema del enriquecimiento.
import { geminiApiKey } from './config.ts';
import { ErrorBuscar } from './errores.ts';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** false cuando no hay GEMINI_API_KEY: el llamador degrada, no truena. */
export function hayModelo(): boolean {
  return Boolean(geminiApiKey());
}

export interface HerramientaEstricta {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface OpcionesLlamada<T> {
  modelo: string;
  sistema: string;
  usuario: string;
  herramienta: HerramientaEstricta;
  maxTokens: number;
  timeoutMs: number;
  /** Pensamiento apagado: para clasificar y ordenar no aporta y se cobra. */
  pensamientoApagado?: boolean;
  /** Valida el input crudo del modelo y devuelve el objeto ya tipado. */
  validar: (crudo: unknown) => T;
}

/**
 * `responseSchema` acepta un subconjunto de OpenAPI, NO JSON Schema completo:
 * con `additionalProperties` —que el modo estricto de Anthropic sí exige— la
 * petición falla con 400 y un mensaje genérico. Se podan esas palabras clave.
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

/**
 * Una llamada, un esquema, una validación. Si algo sale mal, sale un
 * ErrorBuscar con código: nunca un fallo mudo.
 */
export async function llamarConHerramienta<T>(op: OpcionesLlamada<T>): Promise<T> {
  const llave = geminiApiKey();
  if (!llave) {
    throw new ErrorBuscar(
      'LLM_SIN_LLAVE',
      'La síntesis no está disponible: falta configurar la llave de Gemini.',
      { detalle: 'GEMINI_API_KEY no está definida en los secrets de la función.' },
    );
  }

  const cuerpo = {
    systemInstruction: { parts: [{ text: op.sistema }] },
    contents: [{ role: 'user', parts: [{ text: op.usuario }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: aEsquemaGemini(op.herramienta.input_schema),
      temperature: 0,
      maxOutputTokens: op.maxTokens,
      ...(op.pensamientoApagado ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
    },
  };

  const abortador = new AbortController();
  const reloj = setTimeout(() => abortador.abort(), op.timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${BASE}/${op.modelo}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': llave, 'content-type': 'application/json' },
      body: JSON.stringify(cuerpo),
      signal: abortador.signal,
    });
  } catch (e) {
    clearTimeout(reloj);
    if (e instanceof Error && e.name === 'AbortError') {
      throw new ErrorBuscar('LLM_TIMEOUT', 'La respuesta tardó demasiado. Vuelve a intentarlo.', {
        detalle: `Se agotaron los ${op.timeoutMs} ms de presupuesto.`,
      });
    }
    throw new ErrorBuscar('LLM_ERROR', 'Falló el servicio de respuestas.', {
      detalle: e instanceof Error ? e.message : String(e),
    });
  } finally {
    clearTimeout(reloj);
  }

  if (!res.ok) throw await traducirErrorGemini(res);

  const json = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
  };

  if (json.promptFeedback?.blockReason) {
    throw new ErrorBuscar('LLM_RECHAZO', 'El modelo se negó a responder esta consulta.', {
      detalle: `Categoría: ${json.promptFeedback.blockReason}`,
    });
  }

  const candidato = json.candidates?.[0];
  const texto = (candidato?.content?.parts ?? []).map((p) => p.text ?? '').join('');

  if (!texto) {
    throw new ErrorBuscar('LLM_RESPUESTA_INVALIDA', 'El modelo no devolvió una respuesta con la forma esperada.', {
      detalle: `finishReason=${candidato?.finishReason ?? 'desconocido'}; respuesta vacía.`,
    });
  }

  let crudo: unknown;
  try {
    crudo = JSON.parse(texto);
  } catch {
    throw new ErrorBuscar('LLM_RESPUESTA_INVALIDA', 'El modelo no devolvió una respuesta con la forma esperada.', {
      detalle:
        candidato?.finishReason === 'MAX_TOKENS'
          ? 'La respuesta se cortó por longitud y quedó JSON incompleto.'
          : 'La respuesta no es JSON válido pese a pedirse con esquema.',
    });
  }

  return op.validar(crudo);
}

async function traducirErrorGemini(res: Response): Promise<ErrorBuscar> {
  const texto = await res.text().catch(() => '');
  let mensaje = texto.slice(0, 300);
  try {
    mensaje = (JSON.parse(texto) as { error?: { message?: string } }).error?.message ?? mensaje;
  } catch {
    // se queda el texto crudo
  }

  if (res.status === 429) {
    // La capa gratuita de Gemini permite 20 peticiones AL DÍA por modelo, no
    // por minuto: si es eso, esperar un minuto no arregla nada. Se distingue
    // para no prometerle al editor un reintento que va a fallar igual.
    const porDia = /per\s*day|PerDay/i.test(mensaje);
    return new ErrorBuscar('LLM_LIMITE', 'El servicio de respuestas está saturado ahora mismo.', {
      detalle: mensaje,
      sugerencia: porDia
        ? 'Se agotó la cuota diaria de Gemini. Activa facturación en Google Cloud; el modo Catálogo sigue disponible.'
        : 'Espera un minuto y reintenta; el modo Catálogo sigue disponible.',
      reintentar_en_s: porDia ? undefined : 60,
    });
  }

  if (res.status === 401 || res.status === 403) {
    return new ErrorBuscar('LLM_SIN_LLAVE', 'La síntesis no está disponible: la llave de Gemini fue rechazada.', {
      detalle: `HTTP ${res.status}: ${mensaje}`,
    });
  }

  return new ErrorBuscar('LLM_ERROR', 'Falló el servicio de respuestas.', {
    detalle: `HTTP ${res.status}: ${mensaje}`,
  });
}
