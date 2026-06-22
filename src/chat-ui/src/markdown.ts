function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function renderMarkdown(text: string): string {
  const codeBlocks: string[] = []
  let result = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    const idx = codeBlocks.length
    const escaped = escapeHtml(code.trim())
    const langLabel = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : ''
    codeBlocks.push(`<div class="code-block">${langLabel}<pre><code>${escaped}</code></pre></div>`)
    return `\x00CB${idx}\x00`
  })

  const inlineCodes: string[] = []
  result = result.replace(/`([^`\n]+)`/g, (_match, code) => {
    const idx = inlineCodes.length
    inlineCodes.push(`<code class="inline-code">${escapeHtml(code)}</code>`)
    return `\x00IC${idx}\x00`
  })

  result = escapeHtml(result)

  result = result.replace(/\x00CB(\d+)\x00/g, (_m, idx) => codeBlocks[parseInt(idx)])
  result = result.replace(/\x00IC(\d+)\x00/g, (_m, idx) => inlineCodes[parseInt(idx)])

  result = result.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  result = result.replace(/\*(.+?)\*/g, '<em>$1</em>')
  result = result.replace(/__(.+?)__/g, '<strong>$1</strong>')
  result = result.replace(/_(.+?)_/g, '<em>$1</em>')
  result = result.replace(/~~(.+?)~~/g, '<del>$1</del>')

  result = result.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>'
  )

  result = result.replace(
    /(https?:\/\/[^\s<]+)/g,
    (url) => {
      if (url.includes('</a>') || url.includes('href="')) return url
      return `<a href="${url}" target="_blank" rel="noopener">${url}</a>`
    }
  )

  result = result.replace(/\n/g, '<br>')

  return result
}
