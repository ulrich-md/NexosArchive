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
  /**
   * Modelos a probar, en orden. La cuota gratuita de Gemini es de 20
   * peticiones al día POR PROYECTO Y POR MODELO, así que cada uno trae su
   * propio cupo: si el primero está agotado, se prueba el siguiente en vez
   * de degradar con la cuota de los demás intacta (mismo truco que ya usa
   * `scripts/enriquecer.ts`). Un solo elemento sigue funcionando igual que
   * antes.
   */
  modelos: string[];
  sistema: string;
  usuario: string;
  herramienta: HerramientaEstricta;
  maxTokens: number;
  /** Presupuesto por intento (un modelo), no del total de la rotación. */
  timeoutMs: number;
  /** Pensamiento apagado: para clasificar y ordenar no aporta y se cobra. */
  pensamientoApagado?: boolean;
  /** Valida el input crudo del modelo y devuelve el objeto ya tipado. */
  validar: (crudo: unknown) => T;
  /** Se llama con el modelo que de verdad respondió, para trazas/UI que lo
   *  muestran — con rotación, no siempre es el primero de `modelos`. */
  onModelo?: (modelo: string) => void;
}

/**
 * Modelos con la cuota diaria agotada, aprendido en caliente. Vive mientras
 * viva el isolate: no hace falta que sobreviva un cold start, la cuota se
 * vuelve a probar sola si toca uno nuevo.
 */
const AGOTADOS_HOY = new Set<string>();

/** Modelos que rechazan `thinkingConfig` con 400. Se llena solo, como en
 *  `scripts/lib/gemini.ts`: 3 de 7 lo rechazan y la lista envejece cada vez
 *  que Google publica un modelo nuevo, así que no vale la pena mantenerla
 *  a mano. */
const SIN_THINKING = new Set<string>();

/**
 * `responseSchema` acepta un subconjunto de OpenAPI, NO JSON Schema completo:
 * con `additionalProperties` —que el modo estricto de Anthropic sí exige— la
 * petición falla con 400 y un mensaje genérico. Se podan esas palabras clave.
 *
 * Verificado en vivo (2026-09-17): `type: ['integer', 'null']` —válido en
 * JSON Schema, y lo que usa `anio_pub_desde`/`anio_pub_hasta` en
 * ESQUEMA_ROUTER— también tumba la petición con 400 ("Proto field is not
 * repeating, cannot start list"). Gemini no soporta `type` como arreglo; el
 * nulable se marca con `nullable: true` junto a un `type` único. Esto hacía
 * que el router con IA (escalón 3) fallara SIEMPRE que llegaba a llamarse, en
 * silencio hacia el editor: degradaba a las reglas y lo avisaba en la traza,
 * pero nunca se corrigió la causa. Se resuelve aquí, en el transformador
 * genérico, para cubrir cualquier esquema futuro con el mismo patrón.
 */
export function aEsquemaGemini(nodo: unknown): unknown {
  if (Array.isArray(nodo)) return nodo.map(aEsquemaGemini);
  if (!nodo || typeof nodo !== 'object') return nodo;

  const fuera = new Set(['additionalProperties', '$schema', 'strict', 'default', 'examples', 'title']);
  const obj = nodo as Record<string, unknown>;

  // `type: [X, 'null']` (o el orden inverso) → `type: X, nullable: true`.
  let tipoNulable: string | null = null;
  if (Array.isArray(obj.type) && obj.type.length === 2 && obj.type.includes('null')) {
    const otro = obj.type.find((t) => t !== 'null');
    if (typeof otro === 'string') tipoNulable = otro;
  }

  const salida: Record<string, unknown> = {};
  for (const [clave, valor] of Object.entries(obj)) {
    if (fuera.has(clave)) continue;
    if (clave === 'type' && tipoNulable) {
      salida.type = tipoNulable;
      salida.nullable = true;
      continue;
    }
    salida[clave] = aEsquemaGemini(valor);
  }
  return salida;
}

/** Una llamada a UN modelo concreto. Reintenta una vez, en el mismo modelo,
 *  si rechaza `thinkingConfig` con 400 — no es una falla del modelo, es que
 *  no soporta el campo. */
async function llamarUnModelo<T>(
  modelo: string,
  llave: string,
  op: OpcionesLlamada<T>,
): Promise<T> {
  const armarCuerpo = (conThinking: boolean) => ({
    systemInstruction: { parts: [{ text: op.sistema }] },
    contents: [{ role: 'user', parts: [{ text: op.usuario }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: aEsquemaGemini(op.herramienta.input_schema),
      temperature: 0,
      maxOutputTokens: op.maxTokens,
      ...(conThinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
    },
  });

  let conThinking = Boolean(op.pensamientoApagado) && !SIN_THINKING.has(modelo);
  let cuerpo = armarCuerpo(conThinking);

  for (let intento = 0; ; intento++) {
    const abortador = new AbortController();
    const reloj = setTimeout(() => abortador.abort(), op.timeoutMs);

    let res: Response;
    try {
      res = await fetch(`${BASE}/${modelo}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': llave, 'content-type': 'application/json' },
        body: JSON.stringify(cuerpo),
        signal: abortador.signal,
      });
    } catch (e) {
      clearTimeout(reloj);
      if (e instanceof Error && e.name === 'AbortError') {
        throw new ErrorBuscar('LLM_TIMEOUT', 'La respuesta tardó demasiado. Vuelve a intentarlo.', {
          detalle: `${modelo}: se agotaron los ${op.timeoutMs} ms de presupuesto.`,
        });
      }
      throw new ErrorBuscar('LLM_ERROR', 'Falló el servicio de respuestas.', {
        detalle: `${modelo}: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      clearTimeout(reloj);
    }

    // Un 400 con thinkingConfig puesto casi siempre es eso: se reintenta sin
    // él, en el mismo modelo, y se anota para no repetir el viaje después.
    if (!res.ok && res.status === 400 && conThinking && intento === 0) {
      if (!SIN_THINKING.has(modelo)) {
        SIN_THINKING.add(modelo);
        console.warn(`[gemini] ${modelo} no acepta thinkingConfig; se reintenta sin él.`);
      }
      conThinking = false;
      cuerpo = armarCuerpo(false);
      continue;
    }

    if (!res.ok) throw await traducirErrorGemini(res, modelo);

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
        detalle: `${modelo}: finishReason=${candidato?.finishReason ?? 'desconocido'}; respuesta vacía.`,
      });
    }

    let crudo: unknown;
    try {
      crudo = JSON.parse(texto);
    } catch {
      throw new ErrorBuscar('LLM_RESPUESTA_INVALIDA', 'El modelo no devolvió una respuesta con la forma esperada.', {
        detalle:
          candidato?.finishReason === 'MAX_TOKENS'
            ? `${modelo}: la respuesta se cortó por longitud y quedó JSON incompleto.`
            : `${modelo}: la respuesta no es JSON válido pese a pedirse con esquema.`,
      });
    }

    const validado = op.validar(crudo);
    op.onModelo?.(modelo);
    return validado;
  }
}

/**
 * Un esquema, una validación, con rotación de modelo si la cuota diaria de
 * uno se agotó. Si algo sale mal, sale un ErrorBuscar con código: nunca un
 * fallo mudo.
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

  const candidatos = op.modelos.filter((m) => !AGOTADOS_HOY.has(m));
  if (candidatos.length === 0) {
    throw new ErrorBuscar('LLM_LIMITE', 'El servicio de respuestas está saturado ahora mismo.', {
      detalle: `Los ${op.modelos.length} modelos configurados agotaron su cuota diaria.`,
      sugerencia: 'El modo Catálogo sigue disponible.',
    });
  }

  let ultimoError: ErrorBuscar | null = null;
  for (const modelo of candidatos) {
    try {
      return await llamarUnModelo(modelo, llave, op);
    } catch (e) {
      const err = e instanceof ErrorBuscar
        ? e
        : new ErrorBuscar('LLM_ERROR', 'Falló el servicio de respuestas.', {
          detalle: e instanceof Error ? e.message : String(e),
        });

      // Solo la cuota agotada justifica cambiar de modelo: cualquier otro
      // error (esquema roto, respuesta inválida, llave mala) se va a repetir
      // igual en el siguiente, así que se corta ahí y se avisa de una vez.
      if (err.codigo !== 'LLM_LIMITE') throw err;

      // Solo se bloquea el modelo por el resto del día cuando la cuota que se
      // agotó es la del DÍA. Un 429 por minuto se pasa solo, así que no
      // amerita perder el modelo para el resto de las peticiones del isolate.
      const porDia = (err.causa as { porDia?: boolean } | undefined)?.porDia === true;
      if (porDia) AGOTADOS_HOY.add(modelo);
      ultimoError = err;
    }
  }

  throw ultimoError ?? new ErrorBuscar('LLM_ERROR', 'Falló el servicio de respuestas.');
}

async function traducirErrorGemini(res: Response, modelo: string): Promise<ErrorBuscar> {
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
    // para no prometerle al editor un reintento que va a fallar igual, y
    // para que la rotación de modelos solo bloquee el modelo por hoy cuando
    // de verdad es la cuota del día — no por un tope de un minuto que ya se
    // pasó cuando le toque su turno otra vez.
    const porDia = /per\s*day|PerDay/i.test(mensaje);
    return new ErrorBuscar('LLM_LIMITE', 'El servicio de respuestas está saturado ahora mismo.', {
      detalle: `${modelo}: ${mensaje}`,
      sugerencia: porDia
        ? 'Se agotó la cuota diaria de Gemini. Activa facturación en Google Cloud; el modo Catálogo sigue disponible.'
        : 'Espera un minuto y reintenta; el modo Catálogo sigue disponible.',
      reintentar_en_s: porDia ? undefined : 60,
      causa: { porDia },
    });
  }

  if (res.status === 401 || res.status === 403) {
    return new ErrorBuscar('LLM_SIN_LLAVE', 'La síntesis no está disponible: la llave de Gemini fue rechazada.', {
      detalle: `${modelo}: HTTP ${res.status}: ${mensaje}`,
    });
  }

  return new ErrorBuscar('LLM_ERROR', 'Falló el servicio de respuestas.', {
    detalle: `${modelo}: HTTP ${res.status}: ${mensaje}`,
  });
}
