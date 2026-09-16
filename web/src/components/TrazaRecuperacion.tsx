import { useState } from 'react';
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
 * "Consultó el archivo · N pasos", pasos unidos por una línea vertical de
 * 1px, iconos de lucide-react, detalle expandible en mono.
 *
 * Un editor no confía en una caja negra; sí confía en algo que le enseña
 * de dónde salió cada resultado.
 *
 * Los pasos se revelan uno a uno con un pequeño retraso escalonado (pedido
 * explícito), aunque la respuesta ya llegó completa: no hay streaming real
 * del backend, es puro ritmo visual con `animation-delay` por paso — se
 * desactiva solo con `prefers-reduced-motion`.
 */

const ICONOS: Record<IconoTraza, LucideIcon> = {
  interpretacion: Sparkles,
  consulta: Database,
  filtro: Filter,
  orden: ListOrdered,
  lectura: ScanSearch,
  redaccion: PenLine,
};

function Paso({ paso, retraso }: { paso: PasoTraza; retraso: number }) {
  const [abierto, setAbierto] = useState(false);
  const Icono = (paso.icono && ICONOS[paso.icono]) || ScanSearch;
  const tieneDetalle = Boolean(paso.detalle);

  return (
    <div
      className="relative pl-8 motion-safe:animar-aparecer"
      style={{ animationDelay: `${retraso}ms`, animationFillMode: 'backwards' }}
    >
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
  // Abierta por defecto: un editor no confía en una caja negra (sección 3,
  // mejora 3) — pedido explícito de que el "proceso de pensamiento" se vea
  // sin necesidad de un clic extra.
  const [abierta, setAbierta] = useState(true);
  if (pasos.length === 0) return null;

  return (
    <Collapsible open={abierta} onOpenChange={setAbierta} className="border-b border-border pb-3">
      <CollapsibleTrigger className="mono-meta flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground">
        {abierta ? (
          <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
        )}
        Consultó el archivo · {pasos.length} {pasos.length === 1 ? 'paso' : 'pasos'}
      </CollapsibleTrigger>

      <CollapsibleContent className="overflow-hidden motion-safe:data-[state=closed]:animar-plegar motion-safe:data-[state=open]:animar-desplegar">
        <div className="relative mt-3 space-y-4">
          {/* Línea vertical de 1px que une los pasos. */}
          <span className="absolute bottom-2 left-[10px] top-2 w-px bg-border" aria-hidden />
          {pasos.map((paso, i) => (
            <Paso key={`${paso.titulo}-${i}`} paso={paso} retraso={i * 340} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
