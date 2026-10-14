// A quién se le pregunta. Claude Haiku 5.5 primero; Gemini de respaldo.
//
// El router y los carriles solo importan de aquí: no saben qué proveedor
// respondió (la traza sí lo dice, por `onModelo`). Si Claude no tiene llave o
// falla —cupo, red, respuesta que no cumple el esquema—, se intenta Gemini con
// la misma petición antes de rendirse. Un rechazo por seguridad no se reintenta
// en otro proveedor: si un modelo declinó, se respeta y se dice.

import { hayClaude, llamarClaude } from './claude.ts';
import { ErrorBuscar } from './errores.ts';
import { hayModelo as hayGemini, llamarConHerramienta as llamarGemini, type OpcionesLlamada } from './gemini.ts';

export type { OpcionesLlamada };

/** false solo si no hay ninguna llave: el llamador degrada, no truena. */
export function hayModelo(): boolean {
  return hayClaude() || hayGemini();
}

export async function llamarConHerramienta<T>(op: OpcionesLlamada<T>): Promise<T> {
  if (!hayClaude()) return await llamarGemini(op);
  try {
    return await llamarClaude(op);
  } catch (e) {
    const err = e instanceof ErrorBuscar ? e : null;
    if (!hayGemini() || err?.codigo === 'LLM_RECHAZO') throw e;
    console.warn(`[llm] Claude falló (${err?.codigo ?? 'error'}: ${err?.detalle ?? String(e)}); se intenta Gemini.`);
    return await llamarGemini(op);
  }
}
