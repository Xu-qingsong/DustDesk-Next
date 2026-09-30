import { useEffect, useState } from 'react'
import type { LinkGroupRecord } from '../../../shared/types'

export function LinksWidget({ groups }: { groups: LinkGroupRecord[] }) {
  const [selectedGroupId, setSelectedGroupId] = useState(groups[0]?.Id ?? '')
  const selectedGroup = groups.find(group => group.Id === selectedGroupId) ?? groups[0]

  useEffect(() => {
    if (!groups.some(group => group.Id === selectedGroupId)) setSelectedGroupId(groups[0]?.Id ?? '')
  }, [groups, selectedGroupId])

  if (!groups.length) return <div className="widget-empty">暂无链接分类</div>

  return <div className="widget-links">
    <div className="widget-link-tabs" role="tablist" aria-label="链接分类">
      {groups.map(group => <button type="button" role="tab" aria-selected={selectedGroup?.Id === group.Id} className={`widget-link-tab ${selectedGroup?.Id === group.Id ? 'selected' : ''}`} key={group.Id} onClick={() => setSelectedGroupId(group.Id)}>{group.Name}</button>)}
    </div>
    <div className="widget-todos" role="tabpanel">
      {selectedGroup?.Links.map(item => <button className="widget-todo widget-link" key={item.Id} onClick={() => void window.dustdesk.openUrl(item.Url)}><span>{item.Name}</span><small>{item.Url}</small></button>)}
      {!selectedGroup?.Links.length && <div className="widget-empty">这个分类还没有链接</div>}
    </div>
  </div>
}
