/** Small, code-native marks stay crisp at every window and display scale. */
export function CatMark({ size = 24, outline = false }: { size?: number; outline?: boolean }) {
  return <svg width={size} height={size} viewBox="0 0 32 32" fill={outline ? "none" : "currentColor"} aria-hidden="true">
    <path d="M5 13 4 4.5c0-1 1-1.5 1.8-.8L12 8a20 20 0 0 1 8 0l6.2-4.3c.8-.7 1.8-.2 1.8.8L27 13c1 2 1.5 4 1 6.5C27.2 25 22.5 28 16 28S4.8 25 4 19.5C3.5 17 4 15 5 13Z" stroke="currentColor" strokeWidth={outline ? 1.8 : 0} strokeLinejoin="round" />
    {outline && <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="m9 17 2 1 2-1m6 0 2 1 2-1m-9 5 2 1 2-1M2 19l4 1m20 0 4-1" /></g>}
  </svg>;
}
