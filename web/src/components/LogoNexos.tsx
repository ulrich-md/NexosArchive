import { cn } from '@/lib/utilidades';

/**
 * Logo real de Nexos (`web/public/logo-nexos-blue.jpeg`), no una recreación
 * en CSS — pedido explícito del dueño del proyecto: "usa el logo exacto,
 * esta imagen". Nunca otro logo, nunca animado (CLAUDE.md sección 3).
 *
 * Es cuadrado en el archivo original (375×375, azul de marca ya incluido en
 * el jpeg), así que se muestra como cuadrado en las dos escalas, con el
 * radius de 3px que pide la sección 3 aplicado por fuera de la imagen.
 */
export function LogoNexos({
  tamano = 'sm',
  className,
}: {
  tamano?: 'sm' | 'lg';
  className?: string;
}) {
  return (
    <img
      src="/logo-nexos-blue.jpeg"
      alt="nexos"
      className={cn(
        'shrink-0 rounded-[3px] object-cover',
        tamano === 'sm' ? 'h-7 w-7' : 'h-16 w-16 md:h-20 md:w-20',
        className,
      )}
    />
  );
}
