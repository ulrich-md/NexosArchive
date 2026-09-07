import { Fragment } from 'react';
import type { Articulo } from '@/lib/contrato';

/**
 * Renderiza el texto redactado por el modelo.
 *
 * Anti-alucinación (sección 7, regla 1): el modelo escribe marcas
 * `[id:123]`, no títulos ni ligas. Cada marca se resuelve contra los
 * artículos que la base devolvió; si el id no existe, la cita se descarta
 * en silencio en vez de mostrar una referencia inventada.
 *
 * Nunca se renderiza HTML devuelto por el modelo (sección 6): todo entra
 * como texto, y los párrafos se cortan por dobles saltos de línea.
 */
export function TextoRespuesta({
  texto,
  articulos,
}: {
  texto: string;
  articulos: Articulo[];
}) {
  const porId = new Map(articulos.map((a) => [a.id, a]));

  return (
    <div className="space-y-4 font-serif text-[17px] leading-relaxed text-foreground">
      {texto.split(/\n{2,}/).map((parrafo, i) => (
        <p key={i}>
          {parrafo.split(/(\[id:\d+\])/g).map((trozo, j) => {
            const marca = trozo.match(/^\[id:(\d+)\]$/);
            if (!marca) return <Fragment key={j}>{trozo}</Fragment>;

            const articulo = porId.get(Number(marca[1]));
            if (!articulo) return null; // id inexistente ⇒ se descarta la cita

            return (
              <a
                key={j}
                href={articulo.url}
                target="_blank"
                rel="noopener"
                className="mx-0.5 text-primary underline decoration-primary/40 underline-offset-4"
              >
                {articulo.titulo}
              </a>
            );
          })}
        </p>
      ))}
    </div>
  );
}
