import type { ComponentProps } from 'react';
import { Button as UiButton } from '../ui.tsx';

/**
 * ui.tsx sizes buttons in rem (min-h-11) and the root font size is 15px, so they come out at 41px.
 * This wrapper guarantees the 44px touch target the quality bar asks for.
 */
export function Button({ className = '', ...rest }: ComponentProps<typeof UiButton>) {
  return <UiButton {...rest} className={`min-h-[44px]! ${className}`} />;
}
