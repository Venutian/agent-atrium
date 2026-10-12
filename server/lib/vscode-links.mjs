import path from 'node:path'

export const sessionIdValid = id => typeof id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)

/**
 * A Windows path as a person would type it. Some tools record the extended-length form
 * (`\\?\C:\work`), which is the same folder but no link handler understands it.
 */
export const plainPath = (p) => (typeof p === 'string' ? p.replace(/^\\\\\?\\(?!UNC\\)/, '') : p)

export function vscodeFolderUrl(cwd, scheme = 'vscode') {
  cwd = plainPath(cwd)
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !['vscode', 'vscode-insiders'].includes(scheme)) return ''
  const normalized = cwd.replace(/\\/g, '/').replace(/^\/+/, '')
  // Each segment is encoded, but a drive's colon stays a colon: `vscode://file/c:/work`.
  const encoded = normalized.split('/').map((part, i) => (i === 0 && /^[a-z]:$/i.test(part) ? part : encodeURIComponent(part)))
  return `${scheme}://file/${encoded.join('/')}`
}

export function vscodeSessionUrl(cwd, sessionId, scheme = 'vscode') {
  const folder = vscodeFolderUrl(cwd, scheme)
  if (!folder || !sessionIdValid(sessionId)) return ''
  const resource = `vscode-local-chat-session://local/${Buffer.from(sessionId).toString('base64url')}`
  return `${folder}?${new URLSearchParams({ session: resource })}`
}

export function vscodeExtensionUrl(harness, sessionId, scheme = 'vscode', prompt = '') {
  if (!sessionIdValid(sessionId) || !['vscode', 'vscode-insiders'].includes(scheme)) return ''
  if (harness === 'codex') return `${scheme}://openai.chatgpt/local/${sessionId}`
  if (harness === 'claude-code') {
    // The Claude extension's /open handler takes a `prompt` and puts it in the input box,
    // ready for you to send — it does not send it on its own.
    const params = { session: sessionId }
    if (prompt) params.prompt = prompt
    return `${scheme}://anthropic.claude-code/open?${new URLSearchParams(params)}`
  }
  return ''
}

/**
 * Which window holds a VS Code thread: a VS Code window whose title names the folder. VS Code
 * titles read "file — folder — Visual Studio Code", so the folder's own name is the match.
 * `names` are the process name on Windows and the window class on Linux.
 */
export function editorWindow(cwd, scheme = 'vscode') {
  const folder = path.basename(plainPath(cwd) || '')
  const names = scheme === 'vscode-insiders' ? ['Code - Insiders', 'code-insiders'] : ['Code', 'code']
  return { names, title: folder }
}
