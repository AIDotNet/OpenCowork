import ReactMarkdown from 'react-markdown'
import {
  createMarkdownComponents,
  markdownUrlTransform,
  MARKDOWN_REHYPE_PLUGINS,
  MARKDOWN_REMARK_PLUGINS
} from '@renderer/lib/preview/viewers/markdown-components'

export function UpdateReleaseNotes({ children }: { children: string }): React.JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={MARKDOWN_REMARK_PLUGINS}
      rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
      urlTransform={markdownUrlTransform}
      components={createMarkdownComponents()}
    >
      {children}
    </ReactMarkdown>
  )
}
