import * as React from "react"
import { cn } from "@/lib/utils"

const Label = React.forwardRef<
  HTMLLabelElement,
  React.LabelHTMLAttributes<HTMLLabelElement>
>(({ className, ...props }, ref) => (
  <label
    ref={ref}
    className={cn(
      "text-xs font-mono font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 text-muted-foreground uppercase",
      className
    )}
    {...props}
  />
))
Label.displayName = "Label"

export { Label }
