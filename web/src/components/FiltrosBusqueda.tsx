import { SlidersHorizontal } from 'lucide-react';
import type { RespuestaFacetas } from '@/lib/contrato';

/**
 * Filtros de búsqueda, bajo la lista de artículos de cada respuesta (pedido
 * explícito: "primero el resumen y luego artículos, paginados y con filtros
 * de búsqueda abajo").
 *
 * No son un filtro estructurado nuevo en el backend: reutilizan el mismo
 * mecanismo que ya usa el sidebar (`BarraLateral`) — elegir una faceta manda
 * una pregunta en lenguaje natural, y el router de `buscar` la interpreta
 * igual que cualquier otra. Así no se abre un segundo camino de filtrado que
 * pueda desalinearse del primero.
 */
export function FiltrosBusqueda({
  facetas,
  deshabilitado,
  onFiltro,
}: {
  facetas: RespuestaFacetas | null;
  deshabilitado: boolean;
  onFiltro: (pregunta: string) => void;
}) {
  if (!facetas || (facetas.autores.length === 0 && facetas.secciones.length === 0)) return null;

  function elegir(valor: string, tipo: 'autor' | 'seccion' | 'decada') {
    if (!valor) return;
    if (tipo === 'autor') onFiltro(`Todo lo que publicó ${valor} en el archivo`);
    else if (tipo === 'seccion') onFiltro(`Artículos de la sección ${valor}`);
    else onFiltro(`Qué publicó Nexos en los ${valor}`);
  }

  return (
    <div className="max-w-4xl rounded-lg border border-border bg-surface p-3">
      <p className="mono-meta mb-2 flex items-center gap-1.5 text-muted-foreground">
        <SlidersHorizontal className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
        Filtrar más
      </p>
      <div className="flex flex-wrap gap-2">
        <select
          aria-label="Filtrar por autor"
          disabled={deshabilitado}
          value=""
          onChange={(e) => elegir(e.target.value, 'autor')}
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground disabled:opacity-50"
        >
          <option value="">Autor…</option>
          {facetas.autores.slice(0, 100).map((f) => (
            <option key={f.nombre} value={f.nombre}>
              {f.nombre} ({f.n})
            </option>
          ))}
        </select>

        <select
          aria-label="Filtrar por sección"
          disabled={deshabilitado}
          value=""
          onChange={(e) => elegir(e.target.value, 'seccion')}
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground disabled:opacity-50"
        >
          <option value="">Sección…</option>
          {facetas.secciones.slice(0, 100).map((f) => (
            <option key={f.nombre} value={f.nombre}>
              {f.nombre} ({f.n})
            </option>
          ))}
        </select>

        <select
          aria-label="Filtrar por década"
          disabled={deshabilitado}
          value=""
          onChange={(e) => elegir(e.target.value, 'decada')}
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground disabled:opacity-50"
        >
          <option value="">Década…</option>
          {facetas.decadas.map((f) => (
            <option key={f.nombre} value={f.nombre}>
              {f.nombre} ({f.n})
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
