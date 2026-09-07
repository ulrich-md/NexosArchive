import { useState } from 'react';
import { ArrowUpRight, ChevronDown } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { FichaArticulo } from '@/components/FichaArticulo';
import { TextoRespuesta } from '@/components/TextoRespuesta';
import { TrazaRecuperacion } from '@/components/TrazaRecuperacion';
import { ArchivoVacio, CargandoRespuesta, ErrorRespuesta } from '@/components/Estados';
import { MODOS } from '@/lib/constantes';
import type { RespuestaBuscar } from '@/lib/contrato';
import { ErrorConsulta } from '@/lib/api';
import { conMiles, urlBusquedaNexos } from '@/lib/utilidades';

export interface Turno {
  id: string;
  pregunta: string;
  estado: 'cargando' | 'lista' | 'error';
  lento: boolean;
  respuesta: RespuestaBuscar | null;
  error: ErrorConsulta | Error | null;
}

function ListaArticulos({ respuesta }: { respuesta: RespuestaBuscar }) {
  const [abierta, setAbierta] = useState(respuesta.modo === 'catalogo');

  if (respuesta.articulos.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        El archivo sincronizado no contiene artículos para mostrar.
      </p>
    );
  }

  return (
    <Collapsible open={abierta} onOpenChange={setAbierta}>
      <div className="max-w-4xl overflow-hidden rounded-lg border border-border bg-surface">
        <CollapsibleTrigger
          aria-label={abierta ? 'Ocultar artículos' : 'Ver artículos del archivo'}
          className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/60"
        >
          <span className="mono-meta text-foreground">Artículos del archivo</span>
          <span className="flex items-center gap-2">
            <span className="mono-meta tabular text-muted-foreground">
              {conMiles(respuesta.total)} en total
            </span>
            <ChevronDown
              className={`h-4 w-4 text-muted-foreground transition-transform duration-200 ${
                abierta ? 'rotate-180' : ''
              }`}
              strokeWidth={1.75}
              aria-hidden
            />
          </span>
        </CollapsibleTrigger>

        <CollapsibleContent className="overflow-hidden motion-safe:data-[state=closed]:animar-plegar motion-safe:data-[state=open]:animar-desplegar">
          <div className="border-t border-border px-4 py-1">
            {respuesta.articulos.map((a) => (
              <FichaArticulo key={a.id} articulo={a} />
            ))}
          </div>

          {respuesta.total > respuesta.articulos.length ? (
            <p className="mono-meta border-t border-border px-4 py-2 text-muted-foreground">
              Mostrando {conMiles(respuesta.articulos.length)} de {conMiles(respuesta.total)}.
            </p>
          ) : null}
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

export function BloqueRespuesta({
  turno,
  onReintentar,
  onCancelar,
}: {
  turno: Turno;
  onReintentar: () => void;
  onCancelar: () => void;
}) {
  const r = turno.respuesta;
  const etiquetaModo = r ? MODOS.find((m) => m.id === r.modo)?.etiqueta : null;

  return (
    <section className="motion-safe:animar-aparecer">
      {/* La pregunta, tal como se envió. */}
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-lg rounded-br-[3px] border border-primary/30 bg-primary-soft px-4 py-2.5 text-left text-[15px] leading-relaxed text-foreground md:max-w-[70%] md:text-base">
          {turno.pregunta}
        </p>
      </div>

      {turno.estado === 'cargando' ? (
        <div className="mt-6 md:mt-8">
          <CargandoRespuesta lento={turno.lento} onCancelar={onCancelar} />
        </div>
      ) : null}

      {turno.estado === 'error' && turno.error ? (
        <div className="mt-6 md:mt-8">
          <ErrorRespuesta error={turno.error} onReintentar={onReintentar} />
        </div>
      ) : null}

      {turno.estado === 'lista' && r ? (
        r.archivo_vacio ? (
          <div className="mt-6">
            <ArchivoVacio />
          </div>
        ) : (
          <div className="mt-6 space-y-6 md:mt-8">
            <TrazaRecuperacion pasos={r.traza} />

            {r.respuesta ? (
              <div className="border-l-2 border-primary/40 pl-4 md:pl-5">
                <p className="mono-meta mb-2 text-muted-foreground">
                  Respuesta del archivo
                  {etiquetaModo ? (
                    <>
                      <span className="px-1.5 text-border">·</span>
                      {etiquetaModo}
                    </>
                  ) : null}
                  <span className="px-1.5 text-border">·</span>
                  <span className="tabular">{conMiles(r.ms)} ms</span>
                </p>
                <TextoRespuesta texto={r.respuesta} articulos={r.articulos} />
              </div>
            ) : null}

            {/* Nunca una respuesta vacía (sección 7, regla 3). */}
            {r.aproximados ? (
              <p className="max-w-4xl rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
                No encontré coincidencias exactas. Lo más cercano:
                {r.sugerencia ? (
                  <span className="mt-1 block text-foreground">{r.sugerencia}</span>
                ) : null}
              </p>
            ) : null}

            <ListaArticulos respuesta={r} />

            <a
              href={urlBusquedaNexos(turno.pregunta)}
              target="_blank"
              rel="noopener"
              className="mono-meta inline-flex items-center gap-1.5 text-muted-foreground hover:text-primary"
            >
              Ver esta búsqueda en nexos.com.mx
              <ArrowUpRight className="h-3 w-3" strokeWidth={1.75} aria-hidden />
            </a>
          </div>
        )
      ) : null}
    </section>
  );
}
