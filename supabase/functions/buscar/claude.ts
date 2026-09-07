// Llamadas a la API de Claude con el SDK oficial de Anthropic.
//
// Dos reglas que gobiernan este archivo:
//   1. El modelo SIEMPRE responde por medio de una herramienta con esquema
//      estricto (`strict: true`). Nada de "devuélveme un JSON" y a rezar:
//      toda respuesta se valida antes de renderizarse (CLAUDE.md sección 7,
//      regla 5).
//   2. El texto del archivo que entra al prompt es DATO, nunca instrucción.
//      Va delimitado con etiquetas y así se declara en el system prompt
//      (CLAUDE.md sección 6).

import Anthropic from '@anthropic-ai/sdk';
import { anthropicApiKey } from './config.ts';
import { ErrorBuscar } from './errores.ts';

let cliente: Anthropic | null = null;

/** null cuando no hay ANTHROPIC_API_KEY: el llamador degrada, no truena. */
export function clienteClaude(): Anthropic | null {
  const llave = anthropicApiKey();
  if (!llave) return null;
  if (!cliente) cliente = new Anthropic({ apiKey: llave, maxRetries: 1 });
  return cliente;
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
  /** Pensamiento apagado: es incompatible con forzar una herramienta. */
  pensamientoApagado?: boolean;
  /** Valida el input crudo del modelo y devuelve el objeto ya tipado. */
  validar: (crudo: unknown) => T;
}

/**
 * Una llamada, una herramienta forzada, una validación. Si algo sale mal, sale
 * un ErrorBuscar con código: nunca un fallo mudo.
 */
export async function llamarConHerramienta<T>(op: OpcionesLlamada<T>): Promise<T> {
  const claude = clienteClaude();
  if (!claude) {
    throw new ErrorBuscar(
      'LLM_SIN_LLAVE',
      'La síntesis no está disponible: falta configurar la llave de Anthropic.',
      { detalle: 'ANTHROPIC_API_KEY no está definida en los secrets de la función.' },
    );
  }

  // `strict: true` va como campo de la herramienta (no en tool_choice) y exige
  // additionalProperties:false + required completo en el esquema. El tipo
  // `Anthropic.Tool` del SDK puede ir por detrás de esa característica, de ahí
  // el cast: el que manda es el esquema de arriba.
  const parametros = {
    model: op.modelo,
    max_tokens: op.maxTokens,
    system: op.sistema,
    messages: [{ role: 'user', content: op.usuario }],
    tools: [{ ...op.herramienta, strict: true }],
    tool_choice: { type: 'tool', name: op.herramienta.name },
    ...(op.pensamientoApagado ? { thinking: { type: 'disabled' } } : {}),
  } as unknown as Anthropic.MessageCreateParamsNonStreaming;

  let mensaje: Anthropic.Message;
  try {
    mensaje = await claude.messages.create(parametros, {
      timeout: op.timeoutMs,
      maxRetries: 1,
    });
  } catch (e) {
    throw traducirErrorClaude(e);
  }

  if (mensaje.stop_reason === 'refusal') {
    const detalle = (mensaje as unknown as { stop_details?: { category?: string } })
      .stop_details?.category;
    throw new ErrorBuscar(
      'LLM_RECHAZO',
      'El modelo se negó a responder esta consulta.',
      { detalle: detalle ? `Categoría: ${detalle}` : undefined },
    );
  }

  const bloque = mensaje.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === op.herramienta.name,
  );

  if (!bloque) {
    throw new ErrorBuscar(
      'LLM_RESPUESTA_INVALIDA',
      'El modelo no devolvió una respuesta con la forma esperada.',
      {
        detalle: `stop_reason=${mensaje.stop_reason ?? 'desconocido'}; sin bloque tool_use "${op.herramienta.name}".`,
      },
    );
  }

  return op.validar(bloque.input);
}

function traducirErrorClaude(e: unknown): ErrorBuscar {
  if (e instanceof ErrorBuscar) return e;

  if (e instanceof Anthropic.APIConnectionTimeoutError) {
    return new ErrorBuscar('LLM_TIMEOUT', 'La respuesta tardó demasiado. Vuelve a intentarlo.', {
      detalle: e.message,
    });
  }
  if (e instanceof Anthropic.RateLimitError) {
    return new ErrorBuscar('LLM_LIMITE', 'El servicio de respuestas está saturado ahora mismo.', {
      detalle: e.message,
      sugerencia: 'Espera un minuto y reintenta; el modo Catálogo sigue disponible.',
      reintentar_en_s: 60,
    });
  }
  if (e instanceof Anthropic.APIError) {
    return new ErrorBuscar('LLM_ERROR', 'Falló el servicio de respuestas.', {
      detalle: `${e.status ?? ''} ${e.message}`.trim(),
    });
  }
  if (e instanceof Error && e.name === 'AbortError') {
    return new ErrorBuscar('LLM_TIMEOUT', 'La respuesta tardó demasiado. Vuelve a intentarlo.', {
      detalle: e.message,
    });
  }
  return new ErrorBuscar('LLM_ERROR', 'Falló el servicio de respuestas.', {
    detalle: e instanceof Error ? e.message : String(e),
  });
}
