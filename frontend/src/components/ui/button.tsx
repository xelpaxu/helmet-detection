import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva("ui-button inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-md text-base font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-[18px] [&_svg]:shrink-0 cursor-pointer", {
  variants: { variant: { default: "bg-primary text-primary-foreground hover:bg-primary/90", outline: "border border-border bg-surface text-foreground hover:bg-muted", ghost: "text-foreground hover:bg-muted", destructive: "bg-destructive text-white hover:bg-destructive/90" }, size: { default: "px-4 py-2.5", icon: "size-11" } }, defaultVariants: { variant: "default", size: "default" }
});
function Button({ className, variant, size, asChild = false, ...props }: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}
export { Button, buttonVariants };
