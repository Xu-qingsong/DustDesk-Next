import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { AlertTriangle } from 'lucide-react'

export function useConfirmDialog() {
  const [message, setMessage] = useState<string | null>(null), resolve = useRef<((confirmed: boolean) => void) | null>(null), cancel = useRef<HTMLButtonElement>(null), opener = useRef<HTMLElement | null>(null)
  useEffect(() => () => { resolve.current?.(false); resolve.current = null }, [])
  const finish = (confirmed: boolean) => { const pending = resolve.current; resolve.current = null; setMessage(null); pending?.(confirmed) }
  const confirm = (text: string) => {
    if (resolve.current) return Promise.resolve(false)
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return new Promise<boolean>(done => { resolve.current = done; setMessage(text) })
  }
  const confirmationDialog = <Dialog.Root open={message !== null} onOpenChange={open => { if (!open) finish(false) }}><Dialog.Portal>
    <Dialog.Overlay className="control-confirm-overlay" />
    <Dialog.Content role="alertdialog" className="control-confirm-dialog" data-control-popup onKeyDown={event => event.stopPropagation()} onOpenAutoFocus={event => { event.preventDefault(); cancel.current?.focus() }} onCloseAutoFocus={event => { event.preventDefault(); if (opener.current?.isConnected) opener.current.focus({ preventScroll: true }) }}>
      <div className="control-confirm-heading"><span><AlertTriangle size={20} /></span><Dialog.Title>确认删除</Dialog.Title></div>
      <Dialog.Description>{message}</Dialog.Description>
      <div className="control-confirm-actions"><button ref={cancel} type="button" className="secondary-button" onClick={() => finish(false)}>取消</button><button type="button" className="primary-button control-danger-button" onClick={() => finish(true)}>删除</button></div>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>
  return { confirm, confirmationDialog }
}
