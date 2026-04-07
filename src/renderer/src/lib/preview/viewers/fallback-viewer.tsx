import * as React from 'react'
import { CodeEditor } from '@renderer/components/editor/CodeEditor'
import { useChatStore } from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'
import {
  createLocalWorkspace,
  createSshWorkspace,
  getParentPath
} from '@renderer/lib/monaco/workspace'
import type { ViewerProps } from '../viewer-registry'

export function FallbackViewer({
  filePath,
  content,
  onContentChange,
  sshConnectionId,
  editorRef
}: ViewerProps): React.JSX.Element {
  const openFilePreview = useUIStore((state) => state.openFilePreview)
  const workingFolder = useChatStore((state) => {
    const activeSession = state.sessions.find((session) => session.id === state.activeSessionId)
    return activeSession?.workingFolder
  })

  const workspace = React.useMemo(() => {
    if (sshConnectionId) {
      return createSshWorkspace(sshConnectionId, workingFolder ?? getParentPath(filePath))
    }
    return createLocalWorkspace(workingFolder ?? getParentPath(filePath))
  }, [filePath, sshConnectionId, workingFolder])

  const handleOpenFile = React.useCallback(
    (targetPath: string) => {
      openFilePreview(targetPath, 'code', sshConnectionId)
    },
    [openFilePreview, sshConnectionId]
  )

  return (
    <CodeEditor
      filePath={filePath}
      content={content}
      onChange={onContentChange}
      onOpenFile={handleOpenFile}
      workspace={workspace}
    />
  )
}
/>
  )
}
