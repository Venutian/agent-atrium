#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
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
export async function installLinux({ root, home, configHome, dataHome, desktopDir = '', nodeBin = '', noStartup = false, remove = false }) {
  for (const dir of [root, home, configHome, dataHome, ...[desktopDir, nodeBin].filter(Boolean)]) if (!path.isAbsolute(dir) || /[\r\n\0]/.test(dir)) throw new Error('Installation paths must be absolute and single-line')
  const launcher = path.join(home, '.local', 'bin', 'agent-atrium')
  const app = path.join(dataHome, 'applications', 'agent-atrium.desktop')
  const startup = path.join(configHome, 'autostart', 'agent-atrium.desktop')
  const shortcut = desktopDir ? path.join(desktopDir, 'agent-atrium.desktop') : null
  if (remove) {
    for (const file of [launcher, app, startup, shortcut].filter(Boolean)) await fsp.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error })
    return { removed: true }
  }
  await fsp.mkdir(path.dirname(launcher), { recursive: true })
  // Desktop and dock launches skip shell profiles, so nvm-style Node installs are put on PATH here.
  const pathLine = nodeBin ? `export PATH=${shellQuote(nodeBin)}:"$PATH"\n` : ''
  await fsp.writeFile(launcher, `#!/usr/bin/env bash\n${pathLine}exec bash ${shellQuote(path.join(root, 'tools', 'launch.sh'))} "$@"\n`, { mode: 0o755 })
  await fsp.chmod(launcher, 0o755)
  await fsp.mkdir(path.dirname(app), { recursive: true })
  const icon = await fsp.access(path.join(root, 'public', 'icon.svg')).then(() => path.join(root, 'public', 'icon.svg'), () => '')
  await fsp.writeFile(app, desktopEntry(launcher, { icon }), 'utf8')
  if (shortcut) { await fsp.mkdir(desktopDir, { recursive: true }); await fsp.writeFile(shortcut, desktopEntry(launcher, { icon }), { mode: 0o755 }); await fsp.chmod(shortcut, 0o755) }
  if (noStartup) await fsp.unlink(startup).catch(error => { if (error.code !== 'ENOENT') throw error })
  else { await fsp.mkdir(path.dirname(startup), { recursive: true }); await fsp.writeFile(startup, desktopEntry(launcher, { startup: true, icon }), 'utf8') }
  return { launcher, app, shortcut, startup: noStartup ? null : startup }
}
// GNOME-style docks (Ubuntu Dock, Pop!_OS Dock, Dash to Dock) read their pinned apps from this key.
function setDockPin(pinned) {
  try {
    const current = execFileSync('gsettings', ['get', 'org.gnome.shell', 'favorite-apps'], { encoding: 'utf8' })
    const apps = [...current.matchAll(/'([^']+)'/g)].map(match => match[1]).filter(id => id !== 'agent-atrium.desktop')
    if (pinned) apps.push('agent-atrium.desktop')
    execFileSync('gsettings', ['set', 'org.gnome.shell', 'favorite-apps', `[${apps.map(id => `'${id}'`).join(', ')}]`])
    return true
  } catch { return false }
}
function desktopFolder(home) {
  try { const dir = execFileSync('xdg-user-dir', ['DESKTOP'], { encoding: 'utf8' }).trim(); if (path.isAbsolute(dir) && dir !== home) return dir } catch {}
  return path.join(home, 'Desktop')
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'linux') throw new Error('Run this installer on Ubuntu/Linux')
  const allowed = new Set(['--no-startup', '--no-desktop', '--no-dock', '--remove'])
  if (process.argv.slice(2).some(arg => !allowed.has(arg))) throw new Error('Usage: node tools/install-linux.mjs [--no-startup] [--no-desktop] [--no-dock] [--remove]')
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))), home = os.homedir()
  const remove = process.argv.includes('--remove'), noDesktop = process.argv.includes('--no-desktop'), noDock = process.argv.includes('--no-dock')
  const result = await installLinux({ root, home, configHome: process.env.XDG_CONFIG_HOME || path.join(home, '.config'),
    dataHome: process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), desktopDir: remove || !noDesktop ? desktopFolder(home) : '',
    nodeBin: path.dirname(process.execPath), noStartup: process.argv.includes('--no-startup'), remove })
  // GNOME's desktop icons only run a launcher once it is marked trusted.
  if (result.shortcut) try { execFileSync('gio', ['set', result.shortcut, 'metadata::trusted', 'true'], { stdio: 'ignore' }) } catch {}
  const docked = remove ? setDockPin(false) : !noDock && setDockPin(true)
  console.log(result.removed ? 'Removed Agent Atrium launcher, shortcuts and login entry. Project and data are preserved.'
    : 'Installed Agent Atrium in the application menu' + (result.shortcut ? ', on the Desktop' : '') + (docked ? ', in the dock favourites' : '') + (result.startup ? ' and login startup.' : '.'))
}
