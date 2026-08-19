import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'
import type * as React from 'react'

import { cn } from '@/lib/utils'

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:brightness-110',
        /* THE CONFIRM. Save, Create, Send -- the one action a surface exists to
           perform. It is a SOLID accent fill, not a 20% tint of one: a tint on
           a dark page reads as a selected chip, which is why the rename
           dialog's Save button was indistinguishable from its own keyboard
           hints. Tints are for state (selected, active, highlighted); a CTA is
           an object you press. */
        accent: 'bg-accent text-accent-foreground font-bold hover:brightness-110',
        destructive:
          'bg-destructive text-destructive-foreground hover:brightness-110 focus-visible:ring-destructive/40',
        /* Was `bg-background` -- the page colour -- so an outline button was a
           border floating on nothing. It gets a real fill and a strong edge. */
        outline: 'border border-border-strong bg-surface-overlay hover:bg-surface-hover hover:text-foreground',
        secondary: 'border border-border bg-surface-hover text-foreground hover:bg-surface-overlay',
        /* Ghost had NO resting state at all: invisible until hover, and the
           hover fired full-strength `bg-accent` -- a yellow flash -- because
           the `dark:hover:bg-accent/50` meant to soften it never applied (no
           `.dark` ancestor exists). Faint resting edge, quiet surface hover. */
        ghost: 'border border-border-subtle text-fg-muted hover:bg-surface-hover hover:text-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2 has-[>svg]:px-3',
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: 'h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5',
        lg: 'h-10 rounded-md px-6 has-[>svg]:px-4',
        icon: 'size-9',
        'icon-xs': "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'size-8',
        'icon-lg': 'size-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : 'button'

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button }
