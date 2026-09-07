import { useEffect, useRef } from 'react';
import { ArrowUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LINEA_AYUDA, MODOS } from '@/lib/constantes';
import type { Modo } from '@/lib/contrato';
import { cn } from '@/lib/utilidades';

/**
 * Caja de consulta (sección 3).
 *
 * Regla más importante: NUNCA vaciar el input sin dar respuesta. Aquí el
 * texto es estado del padre y solo se limpia cuando llega una respuesta
 * válida; mientras la consulta corre, el textarea queda deshabilitado pero
 * VISIBLE con lo que el usuario escribió, y si falla se conserva íntegro
 * para reintentar.
 */
export function CajaConsulta({
  valor,
  onValor,
  modo,
  onModo,
  onEnviar,
  ocupado,
}: {
  valor: string;
  onValor: (v: string) => void;
  modo: Modo;
  onModo: (m: Modo) => void;
  onEnviar: () => void;
  ocupado: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Crece con el contenido hasta el tope de la caja.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [valor]);

  const vacio = valor.trim().length === 0;

  function enviar() {
    if (vacio || ocupado) return;
    onEnviar();
  }

  return (
    <div className="w-full">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          enviar();
        }}
        className="rounded-2xl border border-border bg-surface md:rounded-lg"
      >
        <div className="flex items-end gap-3 px-3 py-3 sm:px-4">
          <textarea
            ref={ref}
            rows={1}
            value={valor}
            disabled={ocupado}
            onChange={(e) => onValor(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                enviar();
              }
            }}
            placeholder="Pregúntame"
            aria-label="Pregúntame sobre el archivo de Nexos"
            className="max-h-40 min-h-7 w-full resize-none overflow-y-auto bg-transparent text-lg leading-relaxed text-foreground placeholder:text-muted-foreground/70 focus:outline-none disabled:opacity-70"
          />
          <Button
            type="submit"
            variant="circular"
            size="iconoGrande"
            disabled={vacio || ocupado}
            aria-label="Enviar pregunta"
            className="mb-0.5 shrink-0"
          >
            <ArrowUp className="h-4 w-4" strokeWidth={2} aria-hidden />
          </Button>
        </div>

        {/* Línea de ayuda en mono, dentro de la misma caja. */}
        <p className="mono-meta border-t border-border px-3 py-2 text-muted-foreground sm:px-4">
          {LINEA_AYUDA}
        </p>
      </form>

      {/* Tres chips de modo, uno activo a la vez (sección 3, mejora 4). */}
      <div
        className="mt-3 flex flex-wrap items-center gap-2"
        role="radiogroup"
        aria-label="Modo de consulta"
      >
        {MODOS.map((m) => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={modo === m.id}
            title={m.ayuda}
            onClick={() => onModo(m.id)}
            className={cn(
              'mono-meta rounded-[3px] border px-2.5 py-1 transition-all duration-150 motion-safe:active:scale-95',
              modo === m.id
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-surface text-muted-foreground hover:border-primary hover:text-primary',
            )}
          >
            {m.etiqueta}
          </button>
        ))}
      </div>
    </div>
  );
}
