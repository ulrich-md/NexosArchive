// Bitácora (`consultas`) y límite de tasa. La bitácora no es telemetría
// decorativa: toda consulta con cero resultados es backlog (CLAUDE.md
// secciones 5 y 7, regla 3).

import { LIMITE_CONSULTAS_HORA } from './config.ts';
import { bd } from './bd.ts';
import { ErrorBuscar, errorBd } from './errores.ts';
import type { Modo } from './tipos.ts';

/**
 * Límite de 30 consultas por hora y por usuario en todo carril que llame a un
 * LLM (CLAUDE.md sección 6).
 *
 * Nota de implementación: `consultas` no tiene columna para marcar "esta
 * consulta gastó LLM", y el esquema no se toca desde aquí. Se cuenta entonces
 * todo lo registrado que NO sea `catalogo`, es decir `panorama` e `hibrida`,
 * que son los carriles que llaman a Sonnet. El router (Haiku, una llamada
 * corta y barata) puede correr para una consulta que termina en `catalogo` y
 * no consume cuota: es un subconteo acotado y deliberado, no un descuido.
 */
export async function verificarLimite(usuarioId: string | null): Promise<void> {
  if (!usuarioId) return; // los anónimos no llegan a los carriles con LLM
  const desde = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const { count, error } = await bd()
    .from('consultas')
    .select('id', { count: 'exact', head: true })
    .eq('usuario', usuarioId)
    .neq('modo', 'catalogo')
    .gt('creada_en', desde);

  if (error) throw errorBd('conteo de consultas para el límite', error);

  const usadas = count ?? 0;
  if (usadas >= LIMITE_CONSULTAS_HORA) {
    throw new ErrorBuscar(
      'LIMITE_EXCEDIDO',
      `Llegaste al límite de ${LIMITE_CONSULTAS_HORA} consultas por hora.`,
      {
        detalle: `${usadas} consultas en la última hora.`,
        sugerencia: 'El modo Catálogo sigue disponible: no consume el límite.',
        reintentar_en_s: 600,
      },
    );
  }
}

interface RegistroConsulta {
  usuario: string | null;
  pregunta: string;
  modo: Modo;
  n_resultados: number;
  ms: number;
}

/**
 * Registra la consulta. Nunca tumba la respuesta: si la bitácora falla, el
 * editor igual recibe sus resultados (y el fallo queda en el log del servidor).
 * En el runtime de Supabase se manda con `waitUntil` para no cobrarle latencia
 * al carril `catalogo`, que tiene que responder en menos de 100 ms.
 */
export function registrarConsulta(registro: RegistroConsulta): void {
  const promesa = bd()
    .from('consultas')
    .insert({
      usuario: registro.usuario,
      pregunta: registro.pregunta.slice(0, 2_000),
      modo: registro.modo,
      n_resultados: registro.n_resultados,
      ms: Math.round(registro.ms),
    })
    .then(({ error }) => {
      if (error) console.error('[bitacora] no se pudo registrar la consulta:', error.message);
    });

  const runtime = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } })
    .EdgeRuntime;
  if (runtime?.waitUntil) {
    runtime.waitUntil(promesa);
  } else {
    promesa.catch((e) => console.error('[bitacora]', e));
  }
}
