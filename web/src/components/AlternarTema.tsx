import { useCallback, useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';

type Tema = 'claro' | 'oscuro';

function leerTema(): Tema {
  if (typeof document === 'undefined') return 'claro';
  return document.documentElement.classList.contains('dark') ? 'oscuro' : 'claro';
}

/** Toggle de tema claro/oscuro, arriba a la derecha (sección 3). */
export function AlternarTema() {
  const [tema, setTema] = useState<Tema>(leerTema);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', tema === 'oscuro');
    try {
      localStorage.setItem('nexos-tema', tema);
    } catch {
      /* almacenamiento bloqueado: el tema vive solo en esta pestaña */
    }
  }, [tema]);

  const alternar = useCallback(() => setTema((t) => (t === 'oscuro' ? 'claro' : 'oscuro')), []);

  return (
    <Button
      variant="fantasma"
      size="icono"
      onClick={alternar}
      aria-label={tema === 'oscuro' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'}
      className="border border-border"
    >
      {tema === 'oscuro' ? (
        <Sun className="h-4 w-4" strokeWidth={1.75} aria-hidden />
      ) : (
        <Moon className="h-4 w-4" strokeWidth={1.75} aria-hidden />
      )}
    </Button>
  );
}
