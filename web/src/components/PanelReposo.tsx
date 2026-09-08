import { LogoNexos } from '@/components/LogoNexos';
import { ANIO_FINAL, ANIO_INICIAL, EJEMPLOS, TOTAL_ESPERADO } from '@/lib/constantes';
import type { RespuestaFacetas } from '@/lib/contrato';
import { conMiles, saludo } from '@/lib/utilidades';

/**
 * Estado de reposo del panel principal (sección 3).
 *
 * El subtítulo dice `1978–2026 · 32,942 textos`: rango y conteo verificados
 * contra la ingesta reconciliada de los 27 WordPress de Nexos. Si el backend
 * reporta un total distinto —porque la ingesta va a medias— manda el real:
 * decir una cifra redonda con la base incompleta sería repetir exactamente la
 * mentira de la versión de Lovable.
 */
export function PanelReposo({
  facetas,
  onEjemplo,
  deshabilitado,
}: {
  facetas: RespuestaFacetas | null;
  onEjemplo: (pregunta: string) => void;
  deshabilitado: boolean;
}) {
  const sincronizado = facetas !== null && facetas.total_articulos > 0;
  const total = sincronizado ? facetas.total_articulos : TOTAL_ESPERADO;
  const desde = sincronizado ? (facetas.anio_min ?? ANIO_INICIAL) : ANIO_INICIAL;
  const hasta = sincronizado ? (facetas.anio_max ?? ANIO_FINAL) : ANIO_FINAL;

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-10 text-center">
      <LogoNexos tamano="lg" />

      {/* Newsreader weight 400, ~38px. Serif con peso normal: nunca bold. */}
      <h1 className="mt-6 font-serif text-[26px] font-normal leading-snug text-foreground md:mt-8 md:text-[38px]">
        {saludo()}, ¿qué te gustaría consultar hoy?
      </h1>

      <p className="mono-meta mt-3 text-muted-foreground">
        {desde}–{hasta} · {conMiles(total)} textos
      </p>

      {facetas !== null && facetas.total_articulos === 0 ? (
        <p className="mt-2 max-w-md text-sm text-muted-foreground">
          El archivo aún no se ha sincronizado, así que estas cifras son la meta de la ingesta, no
          lo que hay cargado. Corre la carga desde{' '}
          <a href="/admin" className="text-primary underline underline-offset-4">
            /admin
          </a>
          .
        </p>
      ) : null}

      {/* Tres ejemplos clicables (sección 3, mejora 6). */}
      <ul className="mt-8 flex w-full max-w-[560px] flex-col gap-2">
        {EJEMPLOS.map((ejemplo) => (
          <li key={ejemplo}>
            <button
              type="button"
              disabled={deshabilitado}
              onClick={() => onEjemplo(ejemplo)}
              className="w-full rounded-md border border-border bg-surface px-3 py-2 text-left text-sm text-foreground transition-colors hover:border-primary hover:text-primary disabled:opacity-50"
            >
              {ejemplo}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
