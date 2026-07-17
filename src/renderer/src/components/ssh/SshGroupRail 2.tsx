import { useTranslation } from 'react-i18next'
import { Folder, FolderOpen, Plus, Server } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { type SshConnection, type SshGroup } from '@renderer/stores/ssh-store'

import { getGroupHostCount } from './ssh-host-list-helpers'

export function GroupRail({
  groups,
  connections,
  selectedGroupId,
  collapsed,
  onSelectGroup,
  onCreateGroup
}: {
  groups: SshGroup[]
  connections: SshConnection[]
  selectedGroupId: string | null
  collapsed: boolean
  onSelectGroup: (groupId: string | null) => void
  onCreateGroup: () => void
}): React.JSX.Element {
  const { t } = useTranslation('ssh')
  const ungroupedCount = getGroupHostCount(connections, null)
  const showUngrouped = ungroupedCount > 0

  const treeItemClass = (active: boolean): string =>
    cn(
      'flex w-full items-center gap-2 rounded-[8px] px-3 py-2 text-left text-[13px] transition-colors',
      active ? 'bg-[#2b2b2b] text-white' : 'text-[#d4d4d8] hover:bg-[#212121] hover:text-white'
    )

  return (
    <aside
      className={cn(
        'shrink-0 border-r border-[#2d2d2d] bg-[#141414] text-white transition-all',
        collapsed ? 'w-[68px]' : 'w-[285px]'
      )}
    >
      <div className="h-full overflow-y-auto px-2 py-3">
        {collapsed ? (
          <div className="flex flex-col items-center gap-3 pt-2 text-[#9ca3af]">
            <Folder className="size-4" />
            {groups.slice(0, 3).map((group) => (
              <button
                key={group.id}
                type="button"
                onClick={() => onSelectGroup(group.id)}
                className={cn(
                  'inline-flex size-8 items-center justify-center rounded-[8px] transition-colors',
                  selectedGroupId === group.id
                    ? 'bg-[#2b2b2b] text-white'
                    : 'hover:bg-[#212121] hover:text-white'
                )}
                title={group.name}
              >
                <FolderOpen className="size-4" />
              </button>
            ))}
            {showUngrouped ? <Server className="size-4" /> : null}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-[10px] border border-[#2a2a2a] bg-[#161616] px-2 py-2">
              <div className="mb-2 flex items-center justify-between px-2 text-[13px] text-[#d4d4d8]">
                <span>{t('workspace.groupRailTitle')}</span>
                <button
                  type="button"
                  onClick={onCreateGroup}
                  className="rounded-[6px] px-2 py-1 text-[#9ca3af] hover:bg-[#212121] hover:text-white"
                  title={t('newGroup')}
                >
                  <Plus className="size-3.5" />
                </button>
              </div>

              <div className="space-y-1">
                <button
                  type="button"
                  onClick={() => onSelectGroup(null)}
                  className={treeItemClass(selectedGroupId === null)}
                >
                  <Folder className="size-4" />
                  <span className="truncate">{t('workspace.allVaults')}</span>
                  <span className="ml-auto text-[#777]">{connections.length}</span>
                </button>

                <div className="ml-4 space-y-1 border-l border-[#2a2a2a] pl-3">
                  {groups.length === 0 ? (
                    <div className="px-3 py-3 text-[12px] leading-5 text-[#7a7a7a]">
                      {t('workspace.emptyGroupsDesc', {
                        defaultValue: 'No groups yet. Create one to organize your hosts.'
                      })}
                    </div>
                  ) : null}

                  {groups.map((group) => (
                    <button
                      key={group.id}
                      type="button"
                      onClick={() => onSelectGroup(group.id)}
                      className={treeItemClass(selectedGroupId === group.id)}
                    >
                      <FolderOpen className="size-4" />
                      <span className="truncate">{group.name}</span>
                      <span className="ml-auto text-[#777]">
                        {getGroupHostCount(connections, group.id)}
                      </span>
                    </button>
                  ))}

                  {showUngrouped ? (
                    <button
                      type="button"
                      onClick={() => onSelectGroup('__ungrouped__')}
                      className={treeItemClass(selectedGroupId === '__ungrouped__')}
                    >
                      <Server className="size-4" />
                      <span>{t('ungrouped')}</span>
                      <span className="ml-auto text-[#777]">{ungroupedCount}</span>
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </aside>
  )
}
