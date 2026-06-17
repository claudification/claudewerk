/**
 * THE DIALOGUE — opt-in dialog width -> Tailwind class. Shared by the one-shot
 * modal and the persistent inline renderer so both honour `layout.width`
 * (normal | wide | full) identically.
 */
export const DIALOG_WIDTH_CLASS: Record<string, string> = {
  normal: 'sm:w-[560px]',
  wide: 'sm:w-[min(900px,92vw)]',
  full: 'sm:w-[96vw] sm:max-w-[1400px]',
}

export function dialogWidthClass(width: string | undefined): string {
  return DIALOG_WIDTH_CLASS[width ?? 'normal'] ?? DIALOG_WIDTH_CLASS.normal
}
