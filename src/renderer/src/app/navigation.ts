import { Timer, Trash2, HeartPulse, BarChart3, Clipboard, Crop, FileText, FolderKanban, Grid2X2, Home, Link2, ListTodo, Monitor } from 'lucide-react'
import type React from 'react'

export type Page = 'focus' | 'recycle' | 'health' | 'overview' | 'tasks' | 'notes' | 'projects' | 'library' | 'clipboard' | 'organizer' | 'monitor' | 'stats' | 'screenshot' | 'settings'
export type IconType = React.ComponentType<{ size?: number; strokeWidth?: number }>

export const nav: { id: Page; label: string; icon: IconType }[] = [
  { id: 'overview', label: '概览', icon: Home }, { id: 'tasks', label: '任务', icon: ListTodo }, { id: 'notes', label: '便签', icon: FileText }, { id: 'projects', label: '项目', icon: FolderKanban }, { id: 'library', label: '资源库', icon: Link2 }, { id: 'clipboard', label: '剪贴板', icon: Clipboard }, { id: 'organizer', label: '桌面收纳', icon: Grid2X2 }, { id: 'screenshot', label: '截图编辑', icon: Crop }, { id: 'monitor', label: '系统检测', icon: Monitor }, { id: 'focus', label: '专注计时', icon: Timer }, { id: 'stats', label: '统计分析', icon: BarChart3 }, { id: 'health', label: '资源检查', icon: HeartPulse }, { id: 'recycle', label: '回收站', icon: Trash2 }
]

export const pageDescriptions: Record<Page, string> = {
  focus: '关联任务，记录实际专注时间。', recycle: '已删除的内容保留 30 天。', health: '检查资源路径和链接状态。', overview: '把注意力留给真正重要的事情。', tasks: '把今天要完成的事情放在一个清晰的队列里。', notes: '把灵感、会议记录和临时信息留在手边。', projects: '把阶段、进度和下一步行动放在同一张地图上。', library: '按分类整理常用链接、应用和文件入口。', clipboard: '最近复制的文字和图片会在这里暂存。', organizer: '将桌面文件按分类整理，支持智能预览、冲突保护和撤销。', screenshot: '捕获屏幕内容，快速标记并保存。', monitor: '查看当前设备的资源状态和工作环境。', stats: '用简单的数字回顾工作区的积累。', settings: '让 DustDesk 适应你的工作方式。'
}
