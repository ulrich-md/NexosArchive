import { ArrowUpRight } from 'lucide-react';
import type { Articulo } from '@/lib/contrato';
import { formatearFecha, urlBusquedaNexos } from '@/lib/utilidades';

/**
 * Ficha de artículo — componente ÚNICO y reutilizable (sección 3, mejora 5).
 * Título en Newsreader que liga a nexos.com.mx, y debajo en mono pequeño
 * `autor · fecha · número`. Sin sombras, sin radios grandes.
 *
 * Todos los datos vienen de la base vía la Edge Function. El modelo nunca
 * escribe un título, un autor, una fecha ni una URL (sección 7, regla 1).
 * Sin autor ⇒ `autor no consignado`, en gris cursiva (regla 2). Jamás se
 * deduce del estilo, del tema ni del año.
 */
export function FichaArticulo({ articulo }: { articulo: Articulo }) {
  const conAutor = articulo.autores.length > 0;

  return (
    <article className="group -mx-3 border-b border-border px-3 py-3 transition-colors last:border-b-0 hover:bg-muted">
      <a
        href={articulo.url}
        target="_blank"
        rel="noopener"
        className="inline-flex items-start gap-1.5 font-serif text-[17px] leading-snug text-foreground decoration-primary/50 underline-offset-4 group-hover:underline"
      >
        {articulo.titulo}
        <ArrowUpRight
          className="mt-1.5 h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
          strokeWidth={1.75}
          aria-hidden
        />
      </a>

      <p className="mono-meta mt-1.5 text-muted-foreground">
        {conAutor ? (
          articulo.autores.map((autor, i) => (
            <span key={autor}>
              {i > 0 ? <span className="px-1">,</span> : null}
              <a
                href={urlBusquedaNexos(autor)}
                target="_blank"
                rel="noopener"
                className="underline-offset-4 hover:text-primary hover:underline"
              >
                {autor}
              </a>
            </span>
          ))
        ) : (
          <span className="italic text-muted-foreground/80">autor no consignado</span>
        )}

        <span className="px-1.5 text-border">·</span>
        <span>{formatearFecha(articulo.fecha_pub)}</span>

        {articulo.numero ? (
          <>
            <span className="px-1.5 text-border">·</span>
            <a
              href={urlBusquedaNexos(articulo.numero)}
              target="_blank"
              rel="noopener"
              className="underline-offset-4 hover:text-primary hover:underline"
            >
              {articulo.numero}
            </a>
          </>
        ) : null}
      </p>

      {articulo.resumen_linea ? (
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          {articulo.resumen_linea}
        </p>
      ) : null}
    </article>
  );
}
