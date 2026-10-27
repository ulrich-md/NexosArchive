// Llamadas a Claude (Haiku 5.5): el proveedor principal desde 2026-10-14.
//
// Misma interfaz que gemini.ts (`OpcionesLlamada`), para que el router y los
// carriles no sepan quién responde. Las dos reglas del archivo no cambian:
//   1. La respuesta llega contra un esquema (salidas estructuradas,
//      `output_config.format`) y además se valida aquí antes de usarse
//      (CLAUDE.md sección 7, regla 5).
//   2. El texto del archivo que entra al prompt es DATO, nunca instrucción.
//
// Tres diferencias de Haiku 5.5 que este archivo respeta (documentación de
// migración a Claude Haiku 5.5):
//   - `temperature`/`top_p`/`top_k` distintos del valor por defecto dan 400:
//     no se mandan. El esquema hace el trabajo que hacía `temperature: 0`.
//   - El pensamiento viene encendido: se apaga (`disabled`, válido en effort
//     low/medium/high) porque clasificar, expandir y redactar sobre fichas no
//     lo necesitan y cuesta latencia. La respuesta se lee por tipo de bloque,
//     nunca por posición.
//   - Puede declinar por seguridad (`stop_reason: "refusal"`) sin respaldo del
//     lado del servidor: se traduce a LLM_RECHAZO y el llamador degrada.

import Anthropic from '@anthropic-ai/sdk';
import { anthropicApiKey, MODELO_CLAUDE } from './config.ts';
import { ErrorBuscar } from './errores.ts';
import type { OpcionesLlamada } from './gemini.ts';

let cliente: Anthropic | null = null;

export function hayClaude(): boolean {
  return Boolean(anthropicApiKey());
}

function obtenerCliente(): Anthropic {
  const llave = anthropicApiKey();
  if (!llave) {
    throw new ErrorBuscar('LLM_SIN_LLAVE', 'La respuesta no está disponible: falta configurar la llave de Claude.', {
      detalle: 'ANTHROPIC_API_KEY no está definida en los secrets de la función.',
    });
  }
  // Un reintento del SDK basta: el reloj de pared de la petición completa es
  // TIMEOUT_TOTAL_MS, y detrás está el respaldo de Gemini.
  if (!cliente) cliente = new Anthropic({ apiKey: llave, maxRetries: 1 });
  return cliente;
}

/**
 * Las salidas estructuradas aceptan un subconjunto de JSON Schema: todo
 * objeto con `additionalProperties: false`, y sin restricciones numéricas, de
 * largo ni de tamaño de arreglo. Los esquemas de validacion.ts traen
 * `minItems`/`maxItems` (que valida igual `validar*` del lado nuestro) y
 * `type: [X, 'null']`, que aquí se escribe como `anyOf`.
 */
export function aEsquemaClaude(nodo: unknown): unknown {
  if (Array.isArray(nodo)) return nodo.map(aEsquemaClaude);
  if (!nodo || typeof nodo !== 'object') return nodo;
  const obj = nodo as Record<string, unknown>;
  const fuera = new Set([
    'minItems', 'maxItems', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
    'multipleOf', 'minLength', 'maxLength', 'pattern', '$schema', 'strict', 'default', 'examples', 'title',
  ]);

  if (Array.isArray(obj.type) && obj.type.length > 1) {
    const { type, ...resto } = obj;
    const limpio = aEsquemaClaude(resto) as Record<string, unknown>;
    return { anyOf: (type as string[]).map((t) => (t === 'null' ? { type: 'null' } : { ...limpio, type: t })) };
  }

  const salida: Record<string, unknown> = {};
  for (const [clave, valor] of Object.entries(obj)) {
    if (fuera.has(clave)) continue;
    salida[clave] = aEsquemaClaude(valor);
  }
  if (salida.type === 'object') salida.additionalProperties = false;
  return salida;
}

function traducirError(e: unknown): ErrorBuscar {
  if (e instanceof ErrorBuscar) return e;
  if (e instanceof Anthropic.APIConnectionTimeoutError) {
    return new ErrorBuscar('LLM_TIMEOUT', 'La respuesta tardó demasiado. Vuelve a intentarlo.', {
      detalle: `${MODELO_CLAUDE}: tiempo agotado.`,
    });
  }
  if (e instanceof Anthropic.RateLimitError) {
    return new ErrorBuscar('LLM_LIMITE', 'El servicio de respuestas está saturado ahora mismo.', {
      detalle: `${MODELO_CLAUDE}: ${e.message}`,
      sugerencia: 'Espera un minuto y reintenta; las búsquedas por autor, año o sección siguen funcionando.',
      reintentar_en_s: 60,
    });
  }
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return new ErrorBuscar('LLM_SIN_LLAVE', 'La respuesta no está disponible: la llave de Claude fue rechazada.', {
      detalle: `${MODELO_CLAUDE}: HTTP ${e.status}: ${e.message}`,
    });
  }
  if (e instanceof Anthropic.APIError) {
    return new ErrorBuscar('LLM_ERROR', 'Falló el servicio de respuestas.', {
      detalle: `${MODELO_CLAUDE}: HTTP ${e.status ?? '?'}: ${e.message}`,
    });
  }
  return new ErrorBuscar('LLM_ERROR', 'Falló el servicio de respuestas.', {
    detalle: `${MODELO_CLAUDE}: ${e instanceof Error ? e.message : String(e)}`,
  });
}

export async function llamarClaude<T>(op: OpcionesLlamada<T>): Promise<T> {
  const c = obtenerCliente();

  const parametros: Anthropic.MessageCreateParamsNonStreaming = {
    model: MODELO_CLAUDE,
    max_tokens: op.maxTokens,
    system: op.sistema,
    messages: [{ role: 'user', content: op.usuario }],
    thinking: { type: 'disabled' },
    output_config: {
      effort: op.esfuerzo ?? 'low',
      format: {
        type: 'json_schema',
        schema: aEsquemaClaude(op.herramienta.input_schema) as Record<string, unknown>,
      },
    },
  };

  let respuesta: Anthropic.Message;
  try {
    if (op.alTexto) {
      // En vivo: el JSON llega por pedazos y `alTexto` los va leyendo; la
      // respuesta que se valida es la del mensaje completo, igual que sin
      // transmisión.
      const flujo = c.messages.stream(parametros, { timeout: op.timeoutMs });
      for await (const evento of flujo) {
        if (evento.type === 'content_block_delta' && evento.delta.type === 'text_delta') {
          op.alTexto(evento.delta.text);
        }
      }
      respuesta = await flujo.finalMessage();
    } else {
      respuesta = await c.messages.create(parametros, { timeout: op.timeoutMs });
    }
  } catch (e) {
    throw traducirError(e);
  }

  if (respuesta.stop_reason === 'refusal') {
    throw new ErrorBuscar('LLM_RECHAZO', 'El modelo se negó a responder esta consulta.', {
      detalle: `${MODELO_CLAUDE}: ${respuesta.stop_details?.category ?? 'sin categoría'}`,
    });
  }

  const texto = respuesta.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('');

  if (respuesta.stop_reason === 'max_tokens') {
    throw new ErrorBuscar('LLM_RESPUESTA_INVALIDA', 'El modelo no devolvió una respuesta con la forma esperada.', {
      detalle: `${MODELO_CLAUDE}: la respuesta se cortó por longitud (max_tokens=${op.maxTokens}).`,
    });
  }

  let crudo: unknown;
  try {
    crudo = JSON.parse(texto);
  } catch {
    throw new ErrorBuscar('LLM_RESPUESTA_INVALIDA', 'El modelo no devolvió una respuesta con la forma esperada.', {
      detalle: `${MODELO_CLAUDE}: la respuesta no es JSON válido pese a pedirse con esquema.`,
    });
  }

  const validado = op.validar(crudo);
  op.onModelo?.(MODELO_CLAUDE);
  return validado;
}
