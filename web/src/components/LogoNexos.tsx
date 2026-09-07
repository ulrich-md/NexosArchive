import { cn } from '@/lib/utilidades';

/**
 * Logo `nexos`: palabra en minúsculas, blanca, semibold,
 * letter-spacing -0.03em, sobre rectángulo #018FBD con radius 3px.
 * Nunca otro logo, nunca animado (CLAUDE.md sección 3).
 *
 * El rectángulo usa el azul literal `#018FBD` y no `--primary`: en modo
 * oscuro `--primary` es #3cb6dc, y el logo de Nexos no cambia de color.
 */
export function LogoNexos({
  tamano = 'sm',
  className,
}: {
  tamano?: 'sm' | 'lg';
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-[3px] bg-[#018FBD] font-sans font-semibold text-white',
        tamano === 'sm' ? 'h-7 px-2.5 text-base' : 'h-16 px-6 text-[40px] md:h-20 md:text-[52px]',
        className,
      )}
      style={{ letterSpacing: '-0.03em' }}
    >
      nexos
    </span>
  );
}
