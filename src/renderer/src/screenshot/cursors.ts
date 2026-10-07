import type { ScreenshotTool } from '../../../shared/screenshotDocument'

// A small cross marks the exact drawing point; the badge identifies the tool.
// White outlines keep both visible over light and dark screenshot pixels.
const badges: Record<Exclude<ScreenshotTool, 'select' | 'text'>, string> = {
  crop: '<path d="M6 3v15h15M3 6h15v15"/>',
  pen: '<path d="m16 3 5 5L8 21H3v-5ZM14 5l5 5M3 16l5 5"/>',
  highlighter: '<path d="m14 3 7 7-9 9-7-7ZM5 12l-2 7 2 2 7-2M2 23h12"/>',
  line: '<path d="m4 20 16-16"/>',
  arrow: '<path d="M4 20 20 4M10 4h10v10"/>',
  rectangle: '<rect x="3" y="5" width="18" height="14" rx="1"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="9" ry="7"/>',
  number: '<circle cx="12" cy="12" r="10"/><path d="m9 9 3-2v10M9 17h6"/>',
  mosaic: '<rect x="3" y="3" width="18" height="18"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/>',
  blur: '<path d="M12 3c-2 4-6 7-6 11a6 6 0 0 0 12 0c0-4-4-7-6-11Z"/><path d="M10 14a3 3 0 0 0 3 3"/>',
  cover: '<path d="m12 2 9 4v6c0 5-6 9-9 10-3-1-9-5-9-10V6Z"/><path d="M8 9h8v7H8Z"/>',
  eraser: '<path d="m14 3 7 7-11 11H5l-4-4ZM7 11l7 7M10 21h12"/>'
}

function drawingCursor(badge: string): string {
  const cross = '<path d="M6 1v3m0 4v3M1 6h3m4 0h3"/>'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32" fill="none" stroke-linecap="round" stroke-linejoin="round"><g stroke="white" stroke-width="3">${cross}</g><g stroke="#172333" stroke-width="1.2">${cross}</g><g transform="translate(12 12) scale(.7)"><g stroke="white" stroke-width="4">${badge}</g><g stroke="#172333" stroke-width="2">${badge}</g></g></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 6 6, crosshair`
}

export const screenshotToolCursors: Record<ScreenshotTool, string> = {
  select: 'default', text: 'text',
  ...Object.fromEntries(Object.entries(badges).map(([tool, badge]) => [tool, drawingCursor(badge)]))
} as Record<ScreenshotTool, string>

export const resizeCursors: Record<string, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' }
