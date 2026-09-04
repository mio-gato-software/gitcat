/** Small, code-native marks stay crisp at every window and display scale. */
export function CatMark({ size = 24, outline = false }: { size?: number; outline?: boolean }) {
  return <svg width={size} height={size} viewBox="0 0 32 32" fill={outline ? "none" : "currentColor"} aria-hidden="true">
    <path d="M5 13 4 4.5c0-1 1-1.5 1.8-.8L12 8a20 20 0 0 1 8 0l6.2-4.3c.8-.7 1.8-.2 1.8.8L27 13c1 2 1.5 4 1 6.5C27.2 25 22.5 28 16 28S4.8 25 4 19.5C3.5 17 4 15 5 13Z" stroke="currentColor" strokeWidth={outline ? 1.8 : 0} strokeLinejoin="round" />
    {outline && <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="m9 17 2 1 2-1m6 0 2 1 2-1m-9 5 2 1 2-1M2 19l4 1m20 0 4-1" /></g>}
  </svg>;
}

export function SleepingCat() {
  return <svg width="116" height="68" viewBox="0 0 140 82" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M102 65H48C14 65 14 42 27 28c14-15 43-13 57 3M51 43c22 0 23 21 5 21-10 0-19-3-25-8 13 3 29 3 32-1M80 44l1-17 12 10 11 2 15-6-4 16c4 7-2 16-13 16-13 0-20-8-22-21Zm9 5 4 2 3-2m6 1 4 2 3-2m-12 6 3 2 3-2M73 45l7 3m-9 3 9 2" />
    <path d="m106 22 6-1-5 8 7-1m8-20 8-1-7 10 8-1" opacity=".65" />
  </svg>;
}
