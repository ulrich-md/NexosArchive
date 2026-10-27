import { Fragment, type ReactNode } from 'react';
import { Puntos } from '@/components/Puntos';
import type { Articulo } from '@/lib/contrato';
import { useEscritura } from '@/lib/escritura';

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
  cola,
}: {
  texto: string;
  articulos: Articulo[];
  /** Algo que va pegado al final del último párrafo (los puntos de "escribiendo"). */
  cola?: ReactNode;
}) {
  const porId = new Map(articulos.map((a) => [a.id, a]));
  const parrafos = texto.split(/\n{2,}/);

  return (
    <div className="space-y-4 font-serif text-[17px] leading-relaxed text-foreground">
      {parrafos.map((parrafo, i) => (
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
          {i === parrafos.length - 1 ? cola : null}
        </p>
      ))}
    </div>
  );
}

/**
 * El mismo texto, escrito letra por letra con los tres puntos al final
 * mientras falta (ver `lib/escritura.ts`). `enVivo` es la vista previa que
 * llega mientras el modelo redacta; sin él, es la respuesta final, que retoma
 * donde iba la vista previa.
 */
export function TextoEscrito({
  texto,
  articulos,
  clave,
  enVivo = false,
}: {
  texto: string;
  articulos: Articulo[];
  clave: string;
  enVivo?: boolean;
}) {
  const { visible, escribiendo } = useEscritura(texto, clave, { enVivo, completo: !enVivo });
  return (
    <TextoRespuesta
      texto={visible}
      articulos={articulos}
      cola={escribiendo ? <Puntos className="ml-1.5 align-middle" /> : null}
    />
  );
}
