import React from 'react'
import type { WorkspaceState } from '../../../shared/types'

export type PersistWorkspace = (next: WorkspaceState, message?: string) => Promise<void>
export interface PageProps { state: WorkspaceState; persist: PersistWorkspace }

type IconType = React.ComponentType<{ size?: number; strokeWidth?: number }>

export function PageHeader({ action }: { eyebrow?: string; title: string; description?: string; action?: React.ReactNode }) {
  return action ? <div className="page-header page-actions-only">{action}</div> : null
}

export function Panel({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <section className={`panel ${className}`}>{children}</section>
}

export function Empty({ icon: Icon, title, description, action }: { icon: IconType; title: string; description: string; action?: React.ReactNode }) {
  return <div className="empty"><div className="empty-icon"><Icon size={20} /></div><strong>{title}</strong><span>{description}</span>{action}</div>
}
