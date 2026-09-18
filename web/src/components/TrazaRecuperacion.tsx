import { useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Database,
  Filter,
  ListOrdered,
  type LucideIcon,
  PenLine,
  ScanSearch,
  Sparkles,
} from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import type { IconoTraza, PasoTraza } from '@/lib/contrato';

/**
 * Traza de recuperación (sección 3, mejora 3).
 *
 * Colapsada es SIEMPRE una sola fila, sin importar cuántos pasos traiga la
 * respuesta (una consulta que degrada varias veces puede traer 8; una lista
 * vertical de 8 pasos se ve enorme y rota el layout — pedido explícito de
 * arreglarlo tras verlo en vivo). El mensajito de esa fila va cambiando,
 * paso a paso, una sola vez al llegar la respuesta —no en bucle indefinido,
 * que en una conversación larga con varios turnos sería una fila de tickers
 * parpadeando a la vez— y se queda fijo en el resumen ("Consultó el archivo
 * · N pasos"). El ritmo es deliberadamente pausado (~3 s de recorrido total,
 * no un parpadeo) y cada cambio de paso funde en vez de saltar, para que se
 * lea como el mismo "pensando" gradual del chat, no como una notificación.
 * Un clic expande el detalle completo, con hora y línea vertical, igual que
 * antes: un editor no confía en una caja negra.
 */

const ICONOS: Record<IconoTraza, LucideIcon> = {
  interpretacion: Sparkles,
  consulta: Database,
  filtro: Filter,
  orden: ListOrdered,
  lectura: ScanSearch,
  redaccion: PenLine,
};

// ~3 s de recorrido total para una traza típica de 3-4 pasos, gradual, no un
// parpadeo (pedido explícito tras verlo en vivo).
const RITMO_MS = 900;

/** Recorre los pasos una sola vez, ~RITMO_MS entre cada uno, y se detiene en
 *  el último. `prefers-reduced-motion` salta directo al final. */
function useIndiceCiclo(total: number): number {
  const [indice, setIndice] = useState(0);

  useEffect(() => {
    setIndice(0);
    if (total <= 1) return;

    const reducido = typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reducido) {
      setIndice(total - 1);
      return;
    }

    let i = 0;
    const intervalo = setInterval(() => {
      i += 1;
      if (i >= total - 1) {
        setIndice(total - 1);
        clearInterval(intervalo);
        return;
      }
      setIndice(i);
    }, RITMO_MS);

    return () => clearInterval(intervalo);
  }, [total]);

  return indice;
}

function DetallePaso({ paso }: { paso: PasoTraza }) {
  const [abierto, setAbierto] = useState(false);
  const Icono = (paso.icono && ICONOS[paso.icono]) || ScanSearch;
  const tieneDetalle = Boolean(paso.detalle);

  return (
    <div className="relative pl-8">
      <span className="absolute left-0 top-0.5 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-surface">
        <Icono className="h-3 w-3 text-primary" strokeWidth={1.75} aria-hidden />
      </span>

      <button
        type="button"
        onClick={() => tieneDetalle && setAbierto((v) => !v)}
        aria-expanded={tieneDetalle ? abierto : undefined}
        className={tieneDetalle ? 'w-full text-left' : 'w-full cursor-default text-left'}
      >
        <span className="block text-sm text-foreground">{paso.titulo}</span>
        {paso.subtitulo || paso.ms !== null ? (
          <span className="mono-meta block text-muted-foreground">
            {paso.subtitulo}
            {paso.subtitulo && paso.ms !== null ? <span className="px-1.5 text-border">·</span> : null}
            {paso.ms !== null ? <span className="tabular">{paso.ms} ms</span> : null}
          </span>
        ) : null}
      </button>

      {tieneDetalle && abierto ? (
        <pre className="mono-meta mt-2 overflow-x-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-muted-foreground">
          {paso.detalle}
        </pre>
      ) : null}
    </div>
  );
}

export function TrazaRecuperacion({ pasos }: { pasos: PasoTraza[] }) {
  const [abierta, setAbierta] = useState(false);
  const indiceCiclo = useIndiceCiclo(pasos.length);
  const ciclando = indiceCiclo < pasos.length - 1;

  if (pasos.length === 0) return null;

  const pasoActual = pasos[indiceCiclo];
  const IconoActual = (pasoActual.icono && ICONOS[pasoActual.icono]) || Sparkles;

  return (
    <Collapsible open={abierta} onOpenChange={setAbierta} className="border-b border-border pb-3">
      <CollapsibleTrigger className="mono-meta flex w-full max-w-full items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground">
        {abierta ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
        )}

        {!abierta && ciclando ? (
          <span
            key={indiceCiclo}
            className="flex min-w-0 items-center gap-1.5 motion-safe:animar-aparecer-lenta"
          >
            <IconoActual
              className="h-3 w-3 shrink-0 text-primary motion-safe:animar-brillo"
              strokeWidth={1.75}
              aria-hidden
            />
            <span className="truncate">{pasoActual.titulo}</span>
          </span>
        ) : (
          <span className="truncate">
            Consultó el archivo · {pasos.length} {pasos.length === 1 ? 'paso' : 'pasos'}
          </span>
        )}
      </CollapsibleTrigger>

      <CollapsibleContent className="overflow-hidden motion-safe:data-[state=closed]:animar-plegar motion-safe:data-[state=open]:animar-desplegar">
        <div className="relative mt-3 space-y-4">
          {/* Línea vertical de 1px que une los pasos. */}
          <span className="absolute bottom-2 left-[10px] top-2 w-px bg-border" aria-hidden />
          {pasos.map((paso, i) => (
            <DetallePaso key={`${paso.titulo}-${i}`} paso={paso} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
