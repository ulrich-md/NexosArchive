import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utilidades';

/**
 * Primitiva al estilo shadcn/ui, calibrada al diseño de la referencia:
 * borde de 1px, radios chicos, cero sombras. Es una lista editorial,
 * no un dashboard (sección 3, mejora 5).
 */
const variantesBoton = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap transition-all duration-150 disabled:pointer-events-none disabled:opacity-40 motion-safe:active:scale-[0.98] [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        contorno:
          'rounded-md border border-border bg-surface text-foreground hover:border-primary hover:text-primary',
        primario: 'rounded-md bg-primary text-primary-foreground hover:opacity-90',
        fantasma: 'rounded-md text-muted-foreground hover:bg-muted hover:text-foreground',
        circular:
          'rounded-full bg-primary text-primary-foreground transition-opacity disabled:opacity-30',
        texto: 'text-muted-foreground transition-colors hover:text-foreground',
      },
      size: {
        sm: 'px-2 py-1 text-sm',
        md: 'px-3 py-2 text-sm',
        icono: 'h-8 w-8',
        iconoGrande: 'h-9 w-9',
      },
    },
    defaultVariants: { variant: 'contorno', size: 'md' },
  },
);

export interface PropsBoton
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof variantesBoton> {}

export const Button = React.forwardRef<HTMLButtonElement, PropsBoton>(
  ({ className, variant, size, type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(variantesBoton({ variant, size }), className)}
      {...props}
    />
  ),
);
Button.displayName = 'Button';

export { variantesBoton };
