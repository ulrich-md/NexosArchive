/**
 * Tres puntos que suben y bajan en ola: "estoy escribiendo", como en un chat.
 * Bajo `prefers-reduced-motion` se quedan quietos.
 */
export function Puntos({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 ${className}`} aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-primary motion-safe:animar-pensando"
          style={{ animationDelay: `${i * 160}ms` }}
        />
      ))}
    </span>
  );
}
