import { useEffect, useState } from 'react';
import { AlertTriangle, Clock, RotateCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorConsulta } from '@/lib/api';

/**
 * Estados visibles (sección 3, mejora 1).
 * Nada de fallas silenciosas: si tarda, se dice; si falla, se dice qué
 * pasó y se ofrece reintentar.
 */

const PASOS_ESPERA = [
  'Interpretando la pregunta',
  'Consultando el archivo',
  'Ordenando por relevancia',
  'Leyendo las fichas recuperadas',
  'Redactando la respuesta',
];

function Puntos() {
  return (
    <span className="flex items-center gap-1" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-primary motion-safe:animar-pensando"
          style={{ animationDelay: `${i * 160}ms` }}
        />
      ))}
    </span>
  );
}

function Pensando() {
  const [paso, setPaso] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setPaso((p) => Math.min(p + 1, PASOS_ESPERA.length - 1)), 2200);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="mono-meta flex flex-wrap items-center gap-x-2 gap-y-1" aria-live="polite">
      <Puntos />
      <span className="text-foreground">Pensando</span>
      <span className="text-border">·</span>
      <span className="text-muted-foreground">{PASOS_ESPERA[paso]}</span>
    </div>
  );
}

/** Esqueletos sobrios mientras carga, más el aviso si pasa de 10 s. */
export function CargandoRespuesta({
  lento,
  onCancelar,
}: {
  lento: boolean;
  onCancelar: () => void;
}) {
  return (
    <div className="space-y-5">
      <Pensando />

      <div className="max-w-4xl space-y-2 border-l-2 border-primary/40 pl-4 md:pl-5">
        <Skeleton className="h-4 w-full" retraso={0} />
        <Skeleton className="h-4 w-11/12" retraso={120} />
        <Skeleton className="h-4 w-3/5" retraso={240} />
      </div>

      <div className="max-w-4xl space-y-3 rounded-lg border border-border bg-surface p-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-1.5">
            <Skeleton className="h-4 w-2/3" retraso={i * 100} />
            <Skeleton className="h-3 w-1/3" retraso={i * 100 + 60} />
          </div>
        ))}
      </div>

      {lento ? (
        <div className="flex max-w-4xl flex-wrap items-center gap-3 rounded-md border border-border bg-muted px-3 py-2">
          <Clock className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden />
          <p className="flex-1 text-sm text-muted-foreground">
            Esta consulta lleva más de 10 segundos. Sigue corriendo; puedes esperar o cancelarla.
          </p>
          <Button variant="contorno" size="sm" onClick={onCancelar}>
            <X className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
            Cancelar
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Error tipado en pantalla, con el detalle que devolvió el backend. */
export function ErrorRespuesta({
  error,
  onReintentar,
}: {
  error: ErrorConsulta | Error;
  onReintentar: () => void;
}) {
  const tipado = error instanceof ErrorConsulta ? error : null;

  return (
    <div className="max-w-4xl rounded-md border border-destructive/40 bg-surface px-4 py-4">
      <div className="flex items-start gap-3">
        <AlertTriangle
          className="mt-0.5 h-4 w-4 shrink-0 text-destructive"
          strokeWidth={1.75}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-foreground">{error.message}</p>

          {tipado?.detalle ? (
            <pre className="mono-meta mt-2 overflow-x-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-muted-foreground">
              {tipado.detalle}
            </pre>
          ) : null}

          <p className="mono-meta mt-2 text-muted-foreground">
            código: {tipado?.codigo ?? 'desconocido'}
          </p>

          <p className="mt-3 text-sm text-muted-foreground">
            Tu pregunta sigue en el campo de abajo: no se perdió.
          </p>

          <Button variant="contorno" size="sm" className="mt-3" onClick={onReintentar}>
            <RotateCw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
            Reintentar
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Estado vacío honesto (sección 7, regla 4). Si la base está vacía no se
 * inventan datos de ejemplo: se dice que falta sincronizar y se manda a /admin.
 */
export function ArchivoVacio() {
  return (
    <div className="max-w-4xl rounded-md border border-border bg-surface px-4 py-6">
      <p className="font-serif text-lg text-foreground">El archivo aún no se ha sincronizado</p>
      <p className="mt-1 text-sm text-muted-foreground">
        No hay artículos cargados todavía. Corre la sincronización desde{' '}
        <a href="/admin" className="text-primary underline underline-offset-4">
          /admin
        </a>
        .
      </p>
    </div>
  );
}
