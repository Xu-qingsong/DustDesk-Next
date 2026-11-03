import { useLayoutEffect, useRef } from 'react'
import { isComposingKey } from '../utils/keyboard'

/** Keep keyboard focus in modal dialogs and return it to their opener. */
export function useDialogFocus(open: boolean, selector: string, onClose: () => void) {
  const close = useRef(onClose)
  close.current = onClose
  const previous = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (!open) {
      const remember = () => { previous.current = document.activeElement instanceof HTMLElement ? document.activeElement : null }
      remember(); document.addEventListener('focusin', remember)
      return () => document.removeEventListener('focusin', remember)
    }
    const dialog = document.querySelector<HTMLElement>(selector)
    if (!dialog) return
    const controls = () => [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]')].filter(element => element.tabIndex >= 0 && !element.closest('[aria-hidden="true"]') && element.getClientRects().length > 0)
    if (!dialog.contains(document.activeElement)) controls()[0]?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isComposingKey(event)) return
      // Radix popups own Escape and their focus loop even though their DOM is
      // portaled outside this dialog. Let them close before the parent dialog.
      if (event.target instanceof HTMLElement && event.target.closest('[data-control-popup]') || dialog.querySelector('[data-control-trigger][aria-expanded="true"]')) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); return }
      if (event.key !== 'Tab') return
      const items = controls(); const first = items[0]; const last = items.at(-1)
      if (!first || !last) { event.preventDefault(); return }
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', keydown, true)
    return () => { document.removeEventListener('keydown', keydown, true); if (previous.current?.isConnected) previous.current.focus() }
  }, [open, selector])
}
