import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0" +
  " hover-elevate active-elevate-2 transition-all duration-200",
  {
    variants: {
      variant: {
        default:
          "bg-black text-white border border-gray-700 shadow-md hover:shadow-lg hover:bg-gray-900 dark:bg-slate-700 dark:hover:bg-slate-600 dark:border-slate-600",
        destructive:
          "bg-red-600 text-white border border-red-700 shadow-md hover:shadow-lg hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-600",
        outline:
          // Shows the background color of whatever card / sidebar / accent background it is inside of.
          // Inherits the current text color.
          " border [border-color:var(--button-outline)]  shadow-xs active:shadow-none ",
        secondary: "border bg-gray-800 text-white border border-gray-600 shadow-sm hover:shadow-md hover:bg-gray-700 dark:bg-slate-600 dark:hover:bg-slate-500 dark:border-slate-500",
        // Add a transparent border so that when someone toggles a border on later, it doesn't shift layout/size.
        ghost: "border border-transparent",
        elegant: "bg-black text-white border border-yellow-600 shadow-lg hover:shadow-xl hover:bg-gray-900 transform hover:scale-105 dark:bg-slate-800 dark:hover:bg-slate-700 dark:border-yellow-500",
        honeycomb: "bg-black text-white border border-yellow-500 shadow-lg hover:shadow-xl hover:bg-gray-900 clip-path-hexagon dark:bg-slate-800 dark:hover:bg-slate-700 dark:border-yellow-400",
      },
      // Heights are set as "min" heights, because sometimes Ai will place large amount of content
      // inside buttons. With a min-height they will look appropriate with small amounts of content,
      // but will expand to fit large amounts of content.
      size: {
        default: "min-h-9 px-4 py-2",
        sm: "min-h-8 rounded-md px-3 text-xs",
        lg: "min-h-10 rounded-md px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  },
)
Button.displayName = "Button"

export { Button, buttonVariants }
