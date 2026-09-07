// Bitácora del avance del enriquecimiento, en disco.
//
// Por qué existe: el enriquecimiento cuesta dinero real, así que la corrida
// tiene que ser reanudable sin volver a pagar lo ya hecho. La base sola no
// alcanza como marca de avance: un artículo puede quedar legítimamente con
// `resumen_linea` en null —cuando el título no sostiene ningún resumen, que es
// justo lo que pide la sección 7— y sería indistinguible de uno sin procesar.
//
// Se escribe una línea por artículo terminado, en JSONL y con appendFileSync,
// después de CADA lote (nunca al final): si la corrida se corta a la mitad, lo
// que ya se pagó queda registrado.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';

export const RUTA_AVANCE = 'datos/enriquecidos.jsonl';

export type EstadoEnriquecimiento = 'ok' | 'vacio' | 'sin_material';

export interface LineaAvance {
  id: number;
  estado: EstadoEnriquecimiento;
  ts: string;
}

/** Lee la bitácora completa. Una línea corrupta se ignora, no tumba la corrida. */
export function leerAvance(): Set<number> {
  const ids = new Set<number>();
  if (!existsSync(RUTA_AVANCE)) return ids;

  for (const linea of readFileSync(RUTA_AVANCE, 'utf8').split('\n')) {
    const texto = linea.trim();
    if (!texto) continue;
    try {
      const registro = JSON.parse(texto) as Partial<LineaAvance>;
      if (typeof registro.id === 'number') ids.add(registro.id);
    } catch {
      // Línea a medio escribir de una corrida interrumpida: se descarta.
    }
  }
  return ids;
}

/** Agrega los artículos ya terminados. Se llama al cerrar cada lote. */
export function anotarAvance(entradas: { id: number; estado: EstadoEnriquecimiento }[]): void {
  if (entradas.length === 0) return;
  mkdirSync('datos', { recursive: true });
  const ts = new Date().toISOString();
  const lineas = entradas.map((e) => JSON.stringify({ id: e.id, estado: e.estado, ts } satisfies LineaAvance)).join('\n');
  appendFileSync(RUTA_AVANCE, lineas + '\n');
}
