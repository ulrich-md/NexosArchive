import { cn } from '@/lib/utilidades';

/**
 * Esqueleto sobrio: un bloque en `--muted` que respira. Sin gradientes ni
 * barridos — la referencia no los tiene y el spec pide animación mínima.
 */
export function Skeleton({
  className,
  retraso = 0,
  ...props
}: React.ComponentProps<'div'> & { retraso?: number }) {
  return (
    <div
      className={cn('rounded-sm bg-muted motion-safe:animar-brillo', className)}
      style={{ animationDelay: `${retraso}ms` }}
      {...props}
    />
  );
}
