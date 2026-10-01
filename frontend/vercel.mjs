const rawOrigin = process.env.ORDERFLOW_API_ORIGIN
if (!rawOrigin) throw new Error('ORDERFLOW_API_ORIGIN must contain the HTTPS Render API origin.')

const origin = new URL(rawOrigin)
if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash) {
  throw new Error('ORDERFLOW_API_ORIGIN must be an HTTPS origin without a path or query.')
}

export const config = {
  framework: 'vite',
  buildCommand: 'npm run build',
  outputDirectory: 'dist',
  rewrites: [
    { source: '/api/:path*', destination: `${origin.origin}/api/:path*` },
    { source: '/((?!api/).*)', destination: '/index.html' },
  ],
}
