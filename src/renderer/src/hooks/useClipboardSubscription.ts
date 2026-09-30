import { useEffect } from 'react'
import type { WorkspaceState } from '../../../shared/types'
import type { PersistWorkspace } from '../components/common'
import { retainClipboardHistory } from '../utils/clipboard'

export function useClipboardSubscription(state: WorkspaceState, persist: PersistWorkspace) {
  useEffect(() => {
    const unsubscribe = window.dustdesk.onClipboardChanged(record => {
      if (state.ClipboardHistory.some(item => item.ImageSha256 === record.ImageSha256)) return
      void persist({ ...state, ClipboardHistory: retainClipboardHistory([record, ...state.ClipboardHistory]) }, '')
    })
    return unsubscribe
  }, [persist, state])
}
