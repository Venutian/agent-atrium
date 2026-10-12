#!/usr/bin/env node
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`
export function desktopQuote(value) {
  if (/[\n\r\0]/.test(value)) throw new Error('Unsupported desktop-entry path')
  return `"${value.replaceAll('\\', '\\\\\\\\').replaceAll('"', '\\\\"').replaceAll('$', '\\\\$').replaceAll('`', '\\\\`').replaceAll('%', '%%')}"`
}
export function desktopEntry(launcher, { startup = false, icon = '' } = {}) {
  return `[Desktop Entry]\nType=Application\nName=Agent Atrium${startup ? ' (background)' : ''}\nComment=Your coding agents in a glass office\nExec=${desktopQuote(launcher)}${startup ? ' --headless' : ''}\n${icon ? `Icon=${icon.replaceAll('\\', '\\\\')}\n` : ''}Terminal=false\nCategories=Development;Utility;\nStartupNotify=false\n`
}
export async function installLinux({ root, home, configHome, dataHome, noStartup = false, remove = false }) {
  for (const dir of [root, home, configHome, dataHome]) if (!path.isAbsolute(dir) || /[\r\n\0]/.test(dir)) throw new Error('Installation paths must be absolute and single-line')
  const launcher = path.join(home, '.local', 'bin', 'agent-atrium')
  const app = path.join(dataHome, 'applications', 'agent-atrium.desktop')
  const startup = path.join(configHome, 'autostart', 'agent-atrium.desktop')
  if (remove) {
    for (const file of [launcher, app, startup]) await fsp.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error })
    return { removed: true }
  }
  await fsp.mkdir(path.dirname(launcher), { recursive: true })
  await fsp.writeFile(launcher, `#!/usr/bin/env bash\nexec bash ${shellQuote(path.join(root, 'tools', 'launch.sh'))} "$@"\n`, { mode: 0o755 })
  await fsp.chmod(launcher, 0o755)
  await fsp.mkdir(path.dirname(app), { recursive: true })
  const icon = await fsp.access(path.join(root, 'public', 'favicon.svg')).then(() => path.join(root, 'public', 'favicon.svg'), () => '')
  await fsp.writeFile(app, desktopEntry(launcher, { icon }), 'utf8')
  if (noStartup) await fsp.unlink(startup).catch(error => { if (error.code !== 'ENOENT') throw error })
  else { await fsp.mkdir(path.dirname(startup), { recursive: true }); await fsp.writeFile(startup, desktopEntry(launcher, { startup: true, icon }), 'utf8') }
  return { launcher, app, startup: noStartup ? null : startup }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'linux') throw new Error('Run this installer on Ubuntu/Linux')
  const allowed = new Set(['--no-startup', '--remove'])
  if (process.argv.slice(2).some(arg => !allowed.has(arg))) throw new Error('Usage: node tools/install-linux.mjs [--no-startup] [--remove]')
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))), home = os.homedir()
  const result = await installLinux({ root, home, configHome: process.env.XDG_CONFIG_HOME || path.join(home, '.config'),
    dataHome: process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), noStartup: process.argv.includes('--no-startup'), remove: process.argv.includes('--remove') })
  console.log(result.removed ? 'Removed Agent Atrium launcher and login entry. Project and data are preserved.' : 'Installed Agent Atrium in the application menu' + (result.startup ? ' and login startup.' : '.'))
}
