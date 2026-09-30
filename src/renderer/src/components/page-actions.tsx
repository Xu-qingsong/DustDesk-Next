import type React from 'react'

export function PageActions({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`page-actions ${className}`}>{children}</div>
}

export function SegmentedActions({ children }: { children: React.ReactNode }) {
  return <div className="segmented">{children}</div>
}
