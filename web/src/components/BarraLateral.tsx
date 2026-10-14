import { useMemo, useState } from 'react';
import {
  ExternalLink,
  LogIn,
  LogOut,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { LogoNexos } from '@/components/LogoNexos';
import { DIAS_RETENCION, PESTANAS, type PestanaId } from '@/lib/constantes';
import type { Faceta, RespuestaFacetas } from '@/lib/contrato';
import type { ResumenConversacion } from '@/lib/conversaciones';
import type { Usuario } from '@/lib/sesion';
import { cn, conMiles } from '@/lib/utilidades';

/**
 * Sidebar izquierda, ~315px, colapsable con un botón en la esquina
 * superior derecha del sidebar (CLAUDE.md sección 3).
 *
 * La lista de facetas se alimenta de la vista materializada `autores_conteo`
 * a través de la Edge Function `facetas` — nunca contando 19 mil filas en
 * vivo, que es lo que hoy la deja en esqueletos permanentes
 * (sección 3, mejora 2).
 */

function FilaFaceta({
  faceta,
  onElegir,
}: {
  faceta: Faceta;
  onElegir: (nombre: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onElegir(faceta.nombre)}
      className="flex w-full items-baseline justify-between gap-3 rounded-[3px] px-2 py-1.5 text-left transition-colors hover:bg-muted"
    >
      <span className="min-w-0 truncate text-sm text-foreground">{faceta.nombre}</span>
      <span className="mono-meta tabular shrink-0 text-muted-foreground">{conMiles(faceta.n)}</span>
    </button>
  );
}

const FORMATO_DIA = new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short' });
const FORMATO_HORA = new Intl.DateTimeFormat('es-MX', { hour: 'numeric', minute: '2-digit' });

function cuando(ms: number): string {
  const fecha = new Date(ms);
  const hoy = new Date();
  const dias = Math.round(
    (new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate()).getTime() -
      new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate()).getTime()) /
      86_400_000,
  );
  if (dias <= 0) return FORMATO_HORA.format(fecha);
  if (dias === 1) return 'ayer';
  return FORMATO_DIA.format(fecha).replace('.', '');
}

function FilaConversacion({
  conversacion,
  activa,
  onAbrir,
  onBorrar,
}: {
  conversacion: ResumenConversacion;
  activa: boolean;
  onAbrir: () => void;
  onBorrar: () => void;
}) {
  // Borrar pide un segundo clic: el icono queda a un pelo de la fila.
  const [confirmando, setConfirmando] = useState(false);
  return (
    <div
      className={cn(
        'group flex items-center gap-1 rounded-[3px] pr-1 transition-colors hover:bg-muted',
        activa && 'bg-muted',
      )}
      onMouseLeave={() => setConfirmando(false)}
    >
      <button
        type="button"
        onClick={onAbrir}
        aria-current={activa ? 'true' : undefined}
        className="flex min-w-0 flex-1 items-baseline justify-between gap-3 px-2 py-1.5 text-left"
      >
        <span className="min-w-0 truncate text-sm text-foreground">{conversacion.titulo}</span>
        <span className="mono-meta tabular shrink-0 text-muted-foreground md:group-hover:hidden md:group-focus-within:hidden">
          {cuando(conversacion.actualizadaEn)}
        </span>
      </button>
      {confirmando ? (
        <button
          type="button"
          onClick={onBorrar}
          onBlur={() => setConfirmando(false)}
          autoFocus
          className="mono-meta shrink-0 rounded-[3px] px-1.5 py-0.5 text-destructive hover:bg-destructive/10"
        >
          Borrar
        </button>
      ) : (
        <button
          type="button"
          aria-label={`Borrar la conversación «${conversacion.titulo}»`}
          onClick={() => setConfirmando(true)}
          className="flex shrink-0 rounded-[3px] p-1 text-muted-foreground hover:text-destructive md:hidden md:focus:flex md:group-hover:flex md:group-focus-within:flex"
        >
          <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
        </button>
      )}
    </div>
  );
}

function SeccionConversaciones({
  usuario,
  recientes,
  actual,
  cargando,
  error,
  onAbrir,
  onBorrar,
  onAcceder,
}: {
  usuario: Usuario | null;
  recientes: ResumenConversacion[];
  actual: string;
  cargando: boolean;
  error: string | null;
  onAbrir: (id: string) => void;
  onBorrar: (id: string) => void;
  onAcceder: () => void;
}) {
  return (
    <section aria-label="Conversaciones" className="mt-5 flex max-h-[34vh] min-h-0 flex-col">
      <p className="mono-meta px-3 font-medium uppercase tracking-[0.14em] text-foreground">
        Conversaciones
      </p>
      <div className="mt-1.5 min-h-0 overflow-y-auto px-2">
        {cargando && recientes.length === 0 ? (
          <div className="space-y-2 px-2 py-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-4" retraso={i * 70} />
            ))}
          </div>
        ) : recientes.length === 0 ? (
          <p className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
            <MessageSquare className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
            Aún no hay conversaciones.
          </p>
        ) : (
          recientes.map((c) => (
            <FilaConversacion
              key={c.id}
              conversacion={c}
              activa={c.id === actual}
              onAbrir={() => onAbrir(c.id)}
              onBorrar={() => onBorrar(c.id)}
            />
          ))
        )}
        {error ? <p className="px-2 py-1 text-sm text-destructive">{error}</p> : null}
      </div>
      {!usuario ? (
        <div className="px-3 pt-2">
          <p className="text-sm text-muted-foreground">Inicia sesión para conservar tus conversaciones.</p>
          <p className="mono-meta mt-1 text-muted-foreground">
            Sin sesión se guardan solo en este navegador y se eliminan a los {DIAS_RETENCION} días.
          </p>
          <Button variant="contorno" onClick={onAcceder} className="mt-2 w-full justify-start gap-2">
            <LogIn className="h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden />
            Iniciar sesión con Google
          </Button>
        </div>
      ) : null}
    </section>
  );
}

export function BarraLateral({
  abierta,
  onAbierta,
  onCerrarMovil,
  facetas,
  cargandoFacetas,
  errorFacetas,
  onReintentarFacetas,
  onNuevoChat,
  onConsulta,
  deshabilitado,
  usuario,
  onAcceder,
  onSalir,
  recientes,
  conversacionActual,
  cargandoRecientes,
  errorRecientes,
  onAbrirConversacion,
  onBorrarConversacion,
}: {
  abierta: boolean;
  onAbierta: (v: boolean) => void;
  onCerrarMovil: () => void;
  facetas: RespuestaFacetas | null;
  cargandoFacetas: boolean;
  errorFacetas: string | null;
  onReintentarFacetas: () => void;
  onNuevoChat: () => void;
  onConsulta: (pregunta: string) => void;
  deshabilitado: boolean;
  usuario: Usuario | null;
  onAcceder: () => void;
  onSalir: () => void;
  recientes: ResumenConversacion[];
  conversacionActual: string;
  cargandoRecientes: boolean;
  errorRecientes: string | null;
  onAbrirConversacion: (id: string) => void;
  onBorrarConversacion: (id: string) => void;
}) {
  const [pestana, setPestana] = useState<PestanaId>('autores');
  const [filtro, setFiltro] = useState('');

  const lista = useMemo<Faceta[]>(() => {
    if (!facetas) return [];
    const base =
      pestana === 'autores'
        ? facetas.autores
        : pestana === 'secciones'
          ? facetas.secciones
          : facetas.decadas;
    const q = filtro.trim().toLowerCase();
    if (!q) return base;
    return base.filter((f) => f.nombre.toLowerCase().includes(q));
  }, [facetas, pestana, filtro]);

  // Al elegir una faceta se lanza una consulta en lenguaje natural: no se
  // consulta la base desde el cliente.
  function elegir(nombre: string) {
    if (deshabilitado) return;
    if (pestana === 'autores') onConsulta(`Todo lo que publicó ${nombre} en el archivo`);
    else if (pestana === 'secciones') onConsulta(`Artículos de la sección ${nombre}`);
    else onConsulta(`Qué publicó Nexos en los ${nombre}`);
  }

  if (!abierta) {
    return (
      <aside className="sticky top-0 z-40 hidden h-[100dvh] w-14 shrink-0 flex-col items-center gap-4 border-r border-border bg-sidebar py-4 md:flex">
        <Button
          variant="texto"
          size="icono"
          aria-label="Abrir barra lateral"
          onClick={() => onAbierta(true)}
        >
          <PanelLeftOpen className="h-4 w-4" strokeWidth={1.75} aria-hidden />
        </Button>
        <Button variant="texto" size="icono" aria-label="Chat nuevo" onClick={onNuevoChat}>
          <Plus className="h-4 w-4" strokeWidth={1.75} aria-hidden />
        </Button>
      </aside>
    );
  }

  return (
    <aside
      className={cn(
        'fixed inset-y-0 left-0 z-50 flex h-[100dvh] w-[84vw] max-w-xs shrink-0 flex-col border-r border-border bg-sidebar',
        'md:sticky md:top-0 md:z-auto md:w-[315px] md:max-w-none md:translate-x-0',
      )}
    >
      {/* Logo + botón de colapsar, esquina superior derecha del sidebar. */}
      <div className="flex items-center justify-between px-3 py-4">
        <LogoNexos tamano="sm" />
        {/* En móvil el sidebar es un cajón: se cierra. En escritorio se colapsa. */}
        <Button
          variant="texto"
          size="icono"
          aria-label="Cerrar menú"
          onClick={onCerrarMovil}
          className="md:hidden"
        >
          <X className="h-5 w-5" strokeWidth={1.75} aria-hidden />
        </Button>
        <Button
          variant="texto"
          size="icono"
          aria-label="Colapsar barra lateral"
          onClick={() => onAbierta(false)}
          className="hidden md:flex"
        >
          <PanelLeftClose className="h-4 w-4" strokeWidth={1.75} aria-hidden />
        </Button>
      </div>

      <div className="px-3">
        <Button
          variant="contorno"
          onClick={onNuevoChat}
          className="group w-full justify-start gap-2"
        >
          <Plus className="h-4 w-4" strokeWidth={1.75} aria-hidden />
          Chat nuevo
        </Button>
      </div>

      <SeccionConversaciones
        usuario={usuario}
        recientes={recientes}
        actual={conversacionActual}
        cargando={cargandoRecientes}
        error={errorRecientes}
        onAbrir={onAbrirConversacion}
        onBorrar={onBorrarConversacion}
        onAcceder={onAcceder}
      />

      <p className="mono-meta mt-5 px-3 font-medium uppercase tracking-[0.14em] text-foreground">
        Explorar el archivo
      </p>

      <div className="mt-2 px-3">
        <div className="flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden />
          <Input
            value={filtro}
            onChange={(e) => setFiltro(e.target.value)}
            placeholder="Filtrar autores y secciones"
            aria-label="Filtrar autores y secciones"
          />
        </div>
      </div>

      <div className="mt-3 flex gap-1 px-3" role="tablist" aria-label="Facetas del archivo">
        {PESTANAS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={pestana === p.id}
            onClick={() => setPestana(p.id)}
            className={cn(
              'mono-meta rounded-[3px] px-2 py-1 transition-all duration-150 motion-safe:active:scale-95',
              pestana === p.id
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {p.etiqueta}
          </button>
        ))}
      </div>

      <nav className="mt-2 flex-1 overflow-y-auto px-2 pb-4">
        {cargandoFacetas ? (
          <div className="space-y-2 px-2 py-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-4" retraso={i * 70} />
            ))}
          </div>
        ) : errorFacetas ? (
          <div className="px-2 py-2">
            <p className="text-sm text-muted-foreground">{errorFacetas}</p>
            <button
              type="button"
              onClick={onReintentarFacetas}
              className="mono-meta mt-2 text-primary underline underline-offset-4"
            >
              Reintentar
            </button>
          </div>
        ) : lista.length === 0 ? (
          <p className="px-2 py-2 text-sm text-muted-foreground">
            {facetas && facetas.total_articulos === 0 ? (
              <>
                El archivo aún no se ha sincronizado. Corre la carga desde{' '}
                <a href="/admin" className="text-primary underline underline-offset-4">
                  /admin
                </a>
                .
              </>
            ) : (
              'Sin coincidencias para ese filtro.'
            )}
          </p>
        ) : (
          lista.map((f) => <FilaFaceta key={f.nombre} faceta={f} onElegir={elegir} />)
        )}
      </nav>

      {usuario ? (
        <div className="flex items-center gap-2 border-t border-border px-3 py-2.5">
          {usuario.avatar ? (
            <img
              src={usuario.avatar}
              alt=""
              referrerPolicy="no-referrer"
              className="h-6 w-6 shrink-0 rounded-full"
            />
          ) : null}
          <span className="min-w-0 flex-1 truncate text-sm text-foreground" title={usuario.correo ?? undefined}>
            {usuario.nombre ?? usuario.correo}
          </span>
          <Button variant="texto" size="icono" aria-label="Cerrar sesión" title="Cerrar sesión" onClick={onSalir}>
            <LogOut className="h-4 w-4" strokeWidth={1.75} aria-hidden />
          </Button>
        </div>
      ) : null}

      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3">
        <a
          href="https://www.nexos.com.mx"
          target="_blank"
          rel="noopener"
          className="mono-meta flex items-center gap-1.5 text-muted-foreground hover:text-primary"
        >
          nexos.com.mx
          <ExternalLink className="h-3 w-3" strokeWidth={1.75} aria-hidden />
        </a>
      </div>
    </aside>
  );
}
