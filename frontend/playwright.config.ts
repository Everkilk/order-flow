import { existsSync } from 'node:fs'
import { defineConfig } from '@playwright/test'

const windowsChrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const windowsEdge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const executablePath = process.env.CHROME_PATH || (existsSync(windowsChrome) ? windowsChrome : existsSync(windowsEdge) ? windowsEdge : undefined)

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    browserName: 'chromium',
    launchOptions: executablePath ? { executablePath } : undefined,
  },
})
