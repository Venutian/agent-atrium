/**
 * Packs the bots' rig and animations into the one glb the office loads.
 *
 * The raw packs are not checked in and the built glbs are, so this is a no-op on a fresh
 * clone — it only has work to do when a pack has been re-downloaded into `assets-src/`.
 */
import { spawnSync } from 'node:child_process'

const STEPS = [
  ['tools/build-crew.mjs'],
]

for (const [script, ...args] of STEPS) {
  const run = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' })
  if (run.status !== 0) process.exit(run.status ?? 1)
}
