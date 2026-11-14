import React, {lazy, Suspense} from 'react'
import {createRoot} from 'react-dom/client'
import {Toaster} from 'sonner'
import {installTauriApi} from './tauri'
import '../styles.css'
import '../productivity.css'
import '../components/ui/controls.css'
import 'react-day-picker/style.css'

const WidgetHost=lazy(()=>import('../widgets/WidgetHost').then(module=>({default:module.WidgetHost})))
const root=createRoot(document.getElementById('root')!)
void installTauriApi().then(async runtime=>{await runtime.api.loadWorkspace();root.render(<React.StrictMode><Suspense fallback={<div className="widget-shell">正在打开组件…</div>}><WidgetHost/></Suspense><Toaster position="bottom-right" duration={2200}/></React.StrictMode>)}).catch(error=>root.render(<main role="alert">无法打开组件，工作区未被替换：{String(error)}</main>))
