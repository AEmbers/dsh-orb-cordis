import { chmod, copyFile, mkdir } from 'node:fs/promises'

await mkdir('lib', { recursive: true })
await copyFile('native/macos-sck-capture', 'lib/macos-sck-capture')
await copyFile('native/libmacos-sck-capture.dylib', 'lib/libmacos-sck-capture.dylib')
await chmod('lib/macos-sck-capture', 0o755)
