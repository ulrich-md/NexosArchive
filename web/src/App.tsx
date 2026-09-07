import { useCallback, useEffect, useRef, useState } from 'react';
import { Menu, X } from 'lucide-react';
import { AlternarTema } from '@/components/AlternarTema';
import { BarraLateral } from '@/components/BarraLateral';
import { BloqueRespuesta, type Turno } from '@/components/BloqueRespuesta';
import { CajaConsulta } from '@/components/CajaConsulta';
import { LogoNexos } from '@/components/LogoNexos';
import { PanelReposo } from '@/components/PanelReposo';
import { Button } from '@/components/ui/button';
import { ErrorConsulta, MS_AVISO_LENTO, MS_LIMITE, buscar, facetas as pedirFacetas } from '@/lib/api';
import type { Modo, RespuestaFacetas } from '@/lib/contrato';
import {
  alCambiarSesion,
  cerrarSesion,
  iniciarSesionGoogle,
  obtenerSesion,
  usuarioDeSesion,
  type Usuario,
} from '@/lib/sesion';

function nuevoId() {
  return globalThis.crypto?.randomUUID?.() ?? String(Date.now() + Math.random());
}

export default function App() {
  const [texto, setTexto] = useState('');
  const [modo, setModo] = useState<Modo>('hibrida');
  const [turnos, setTurnos] = useState<Turno[]>([]);
  const [sidebarAbierta, setSidebarAbierta] = useState(true);
  const [menuMovil, setMenuMovil] = useState(false);

  const [facetas, setFacetas] = useState<RespuestaFacetas | null>(null);
  const [cargandoFacetas, setCargandoFacetas] = useState(true);
  const [errorFacetas, setErrorFacetas] = useState<string | null>(null);

  const [usuario, setUsuario] = useState<Usuario | null>(null);
  const [avisoAcceso, setAvisoAcceso] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const finRef = useRef<HTMLDivElement>(null);

  const ocupado = turnos.some((t) => t.estado === 'cargando');

  // --- Facetas del sidebar -------------------------------------------------
  const cargarFacetas = useCallback(() => {
    setCargandoFacetas(true);
    setErrorFacetas(null);
    pedirFacetas()
      .then((f) => setFacetas(f))
      .catch((e: unknown) =>
        setErrorFacetas(
          e instanceof ErrorConsulta
            ? e.message
            : 'No se pudo cargar la lista de autores y secciones.',
        ),
      )
      .finally(() => setCargandoFacetas(false));
  }, []);

  useEffect(() => cargarFacetas(), [cargarFacetas]);

  // --- Sesión --------------------------------------------------------------
  useEffect(() => {
    let vivo = true;
    void obtenerSesion().then((s) => vivo && setUsuario(usuarioDeSesion(s)));
    const desuscribir = alCambiarSesion((s) => setUsuario(usuarioDeSesion(s)));
    return () => {
      vivo = false;
      desuscribir();
    };
  }, []);

  useEffect(() => {
    finRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turnos]);

  // --- Consulta ------------------------------------------------------------
  const preguntar = useCallback(
    async (pregunta: string, modoUsado: Modo, idTurno: string) => {
      const control = new AbortController();
      abortRef.current = control;

      const marcaLento = window.setTimeout(() => {
        setTurnos((ts) => ts.map((t) => (t.id === idTurno ? { ...t, lento: true } : t)));
      }, MS_AVISO_LENTO);

      const marcaLimite = window.setTimeout(() => control.abort(), MS_LIMITE);

      try {
        const respuesta = await buscar({ pregunta, modo: modoUsado }, control.signal);
        setTurnos((ts) =>
          ts.map((t) =>
            t.id === idTurno ? { ...t, estado: 'lista', lento: false, respuesta } : t,
          ),
        );
        // Solo AQUÍ se vacía el input: hubo respuesta.
        setTexto('');
      } catch (e: unknown) {
        const abortado = e instanceof DOMException && e.name === 'AbortError';
        const error = abortado
          ? new ErrorConsulta(
              'cancelada',
              control.signal.reason === undefined
                ? 'La consulta se detuvo porque pasó de 45 segundos.'
                : 'Cancelaste la consulta.',
            )
          : e instanceof Error
            ? e
            : new ErrorConsulta('desconocido', 'No se pudo consultar el archivo.');

        setTurnos((ts) =>
          ts.map((t) => (t.id === idTurno ? { ...t, estado: 'error', lento: false, error } : t)),
        );
        // El texto NO se toca: la pregunta sigue en el input para reintentar.
      } finally {
        window.clearTimeout(marcaLento);
        window.clearTimeout(marcaLimite);
        abortRef.current = null;
      }
    },
    [],
  );

  const enviar = useCallback(
    (preguntaCruda?: string) => {
      const pregunta = (preguntaCruda ?? texto).trim();
      if (!pregunta || ocupado) return;

      if (preguntaCruda !== undefined) setTexto(preguntaCruda);
      setMenuMovil(false);

      const id = nuevoId();
      setTurnos((ts) => [
        ...ts,
        { id, pregunta, estado: 'cargando', lento: false, respuesta: null, error: null },
      ]);
      void preguntar(pregunta, modo, id);
    },
    [texto, ocupado, modo, preguntar],
  );

  const reintentar = useCallback(
    (turno: Turno) => {
      if (ocupado) return;
      setTurnos((ts) =>
        ts.map((t) =>
          t.id === turno.id
            ? { ...t, estado: 'cargando', lento: false, error: null, respuesta: null }
            : t,
        ),
      );
      void preguntar(turno.pregunta, modo, turno.id);
    },
    [ocupado, modo, preguntar],
  );

  const cancelar = useCallback(() => abortRef.current?.abort('cancelada'), []);

  function nuevoChat() {
    abortRef.current?.abort('cancelada');
    setTurnos([]);
    setTexto('');
    setMenuMovil(false);
  }

  async function acceder() {
    setAvisoAcceso(null);
    try {
      await iniciarSesionGoogle();
    } catch (e: unknown) {
      setAvisoAcceso(e instanceof Error ? e.message : 'No se pudo iniciar sesión.');
    }
  }

  const enConversacion = turnos.length > 0;

  return (
    <div className="flex min-h-[100dvh]">
      <div className={menuMovil ? 'contents' : 'hidden md:contents'}>
        <BarraLateral
          abierta={sidebarAbierta || menuMovil}
          onAbierta={setSidebarAbierta}
          facetas={facetas}
          cargandoFacetas={cargandoFacetas}
          errorFacetas={errorFacetas}
          onReintentarFacetas={cargarFacetas}
          onNuevoChat={nuevoChat}
          onConsulta={(p) => enviar(p)}
          deshabilitado={ocupado}
          usuario={usuario}
          onAcceder={() => void acceder()}
          onSalir={() => void cerrarSesion()}
        />
      </div>

      {menuMovil ? (
        <button
          type="button"
          aria-label="Cerrar menú"
          onClick={() => setMenuMovil(false)}
          className="fixed inset-0 z-40 bg-foreground/30 md:hidden"
        />
      ) : null}

      <main className="flex min-h-[100dvh] min-w-0 flex-1 flex-col">
        {enConversacion ? (
          <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-border bg-background px-4 py-3 md:px-8">
            <Button
              variant="fantasma"
              size="icono"
              aria-label="Abrir menú"
              onClick={() => setMenuMovil(true)}
              className="border border-border md:hidden"
            >
              <Menu className="h-4 w-4" strokeWidth={1.75} aria-hidden />
            </Button>
            <LogoNexos tamano="sm" />
            <div className="ml-auto">
              <AlternarTema />
            </div>
          </header>
        ) : (
          <div className="flex items-center justify-between px-4 pt-4 md:px-6 md:pt-5">
            <Button
              variant="fantasma"
              size="iconoGrande"
              aria-label="Abrir menú"
              onClick={() => setMenuMovil(true)}
              className="rounded-full border border-border md:hidden"
            >
              <Menu className="h-4 w-4" strokeWidth={1.75} aria-hidden />
            </Button>
            <div className="ml-auto">
              <AlternarTema />
            </div>
          </div>
        )}

        {avisoAcceso ? (
          <div className="mx-4 mt-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-surface px-3 py-2 md:mx-8">
            <p className="flex-1 text-sm text-foreground">{avisoAcceso}</p>
            <button
              type="button"
              aria-label="Descartar aviso"
              onClick={() => setAvisoAcceso(null)}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" strokeWidth={1.75} aria-hidden />
            </button>
          </div>
        ) : null}

        {enConversacion ? (
          <div className="flex-1 overflow-y-auto px-4 pb-8 pt-6 md:px-8 md:py-10">
            <div className="mx-auto w-full max-w-3xl space-y-10">
              {turnos.map((t) => (
                <BloqueRespuesta
                  key={t.id}
                  turno={t}
                  onReintentar={() => reintentar(t)}
                  onCancelar={cancelar}
                />
              ))}
              <div ref={finRef} />
            </div>
          </div>
        ) : (
          <PanelReposo
            facetas={facetas}
            deshabilitado={ocupado}
            onEjemplo={(p) => enviar(p)}
          />
        )}

        <div className="sticky bottom-0 z-30 w-full border-t border-border bg-background px-3 py-3 md:relative md:mx-auto md:w-full md:max-w-3xl md:border-0 md:bg-transparent md:px-6 md:pb-16 md:pt-0">
          <CajaConsulta
            valor={texto}
            onValor={setTexto}
            modo={modo}
            onModo={setModo}
            onEnviar={() => enviar()}
            ocupado={ocupado}
          />
        </div>
      </main>
    </div>
  );
}
