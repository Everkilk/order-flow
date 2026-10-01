import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'

const base = 'http://127.0.0.1:5173'
let server

async function isReady() {
  try { return (await fetch(base, { signal: AbortSignal.timeout(1000) })).ok }
  catch { return false }
}

try {
  if (!await isReady()) {
    server = spawn(process.execPath, [join('node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', '5173'], { stdio: 'ignore' })
    let ready = false
    for (let attempt = 0; attempt < 100; attempt++) {
      if (server.exitCode !== null) throw new Error('Vite exited before becoming ready.')
      if (await isReady()) { ready = true; break }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (!ready) throw new Error('Vite did not start within 10 seconds.')
  }
  const runner = spawn(process.execPath, [join('node_modules', '@playwright', 'test', 'cli.js'), 'test', ...process.argv.slice(2)], { stdio: 'inherit' })
  const [code] = await once(runner, 'exit')
  process.exitCode = typeof code === 'number' ? code : 1
} finally {
  if (server && server.exitCode === null) server.kill()
}
