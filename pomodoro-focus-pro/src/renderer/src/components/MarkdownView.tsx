import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** Markdown 渲染（GFM 表格/列表/引用/代码块），不渲染原始 HTML */
function MarkdownView({ content }: { content: string }): JSX.Element {
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  )
}

export default MarkdownView
