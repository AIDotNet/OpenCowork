import type { Components } from 'react-markdown'
import { IPC } from '../../ipc/channels'
import { ipcClient } from '../../ipc/ipc-client'
import { MermaidBlock } from './MermaidBlock'

export function createMarkdownComponents(filePath?: string): Components {
  const fileDir = filePath ? filePath.replace(/[\\/][^\\/]*$/, '') : ''

  return {
    a: ({ href, children, ...props }) => {
      const link = href?.trim() || ''
      const isExternalHttpLink = /^https?:\/\//i.test(link)

      return (
        <a
          {...props}
          href={link || href}
          className="text-primary underline underline-offset-2 hover:text-primary/80 break-all"
          title={link || href}
          onClick={(event) => {
            if (!isExternalHttpLink) return
            event.preventDefault()
            void ipcClient.invoke(IPC.SHELL_OPEN_EXTERNAL, link)
          }}
        >
          {children}
        </a>
      )
    },
    p: ({ children, ...props }) => (
      <p className="whitespace-pre-wrap break-words" {...props}>
        {children}
      </p>
    ),
    li: ({ children, ...props }) => (
      <li className="break-words [&>p]:whitespace-pre-wrap" {...props}>
        {children}
      </li>
    ),
    th: ({ children, ...props }) => (
      <th className="whitespace-pre-wrap break-words" {...props}>
        {children}
      </th>
    ),
    td: ({ children, ...props }) => (
      <td className="whitespace-pre-wrap break-words" {...props}>
        {children}
      </td>
    ),
    img: ({ src, alt, ...props }) => {
      let resolvedSrc = src || ''
      if (
        fileDir &&
        resolvedSrc &&
        !resolvedSrc.startsWith('http') &&
        !resolvedSrc.startsWith('data:') &&
        !resolvedSrc.startsWith('file://')
      ) {
        const sep = fileDir.includes('/') ? '/' : '\\'
        resolvedSrc = `file://${fileDir}${sep}${resolvedSrc.replace(/^\.[/\\]/, '')}`
      }
      return (
        <img
          {...props}
          src={resolvedSrc}
          alt={alt || ''}
          className="my-4 block max-w-full rounded-lg border border-border/50 shadow-sm"
          loading="lazy"
        />
      )
    },
    pre: ({ children }) => <>{children}</>,
    code: ({ children, className }) => {
      const code = String(children ?? '').replace(/\n$/, '')
      const languageMatch = /language-([\w-]+)/.exec(className || '')
      const language = languageMatch?.[1]?.toLowerCase()

      if (!className) {
        return <code className="rounded bg-muted px-1 py-0.5 text-xs">{children}</code>
      }

      if (language === 'mermaid') {
        return <MermaidBlock code={code} />
      }

      return (
        <pre className="my-3 overflow-x-auto rounded-md bg-muted/60 p-3 text-xs">
          <code className={className}>{children}</code>
        </pre>
      )
    }
  }
}
