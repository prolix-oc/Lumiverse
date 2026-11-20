import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { createPrivateKey, generateKeyPairSync, X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const http2 = { ...await import('node:http2') }
const directory = mkdtempSync(join(tmpdir(), 'lumiverse-apns-certificate-'))
const certPath = join(directory, 'apns.cer'), keyPath = join(directory, 'key.pem')
const passwordPath = join(directory, 'passphrase')
const variables = ['APNS_CERTIFICATE_PATH', 'APNS_PRIVATE_KEY_PATH', 'APNS_PRIVATE_KEY_PASSPHRASE_FILE', 'APNS_BUNDLE_ID']
const previous = Object.fromEntries(variables.map(name => [name, process.env[name]]))
const env = { APNS_CERTIFICATE_PATH: certPath, APNS_PRIVATE_KEY_PATH: keyPath,
  APNS_PRIVATE_KEY_PASSPHRASE_FILE: passwordPath, APNS_BUNDLE_ID: 'chat.lumiverse.ios' }
let certificate: Buffer, server: ReturnType<typeof http2.createSecureServer>, port: number
let session: ReturnType<typeof http2.connect>, lastAuthority: string
let received: { peer: string; path: string; authorization: unknown; topic: unknown; payload: unknown }

mock.module('node:http2', () => ({ ...http2, connect(authority: string, options: object) {
  lastAuthority = authority
  // Only reroute the destination. The provider's real HTTP/2 client, TLS
  // certificate authentication, headers, and response handling all run.
  session = http2.connect(`https://127.0.0.1:${port}`, { ...options, ca: certificate })
  return session
} }))
const { loadAPNsConfiguration, getAPNsInfo, sendAPNsNotification } = await import('./apns.service')

beforeAll(async () => {
  const pem = join(directory, 'cert.pem'), plainKey = join(directory, 'plain-key.pem')
  const generated = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', plainKey, '-out', pem, '-days', '1', '-subj', '/UID=chat.lumiverse.ios/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdout: 'ignore', stderr: 'pipe' })
  if (generated.exitCode) throw new Error(generated.stderr.toString())
  certificate = readFileSync(pem)
  const privateKey = createPrivateKey(readFileSync(plainKey))
  writeFileSync(certPath, new X509Certificate(certificate).raw)
  writeFileSync(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8', cipher: 'aes-256-cbc', passphrase: 'fixture-passphrase' }))
  writeFileSync(passwordPath, 'fixture-passphrase\n')
  Object.assign(process.env, env)
  server = http2.createSecureServer({ key: readFileSync(plainKey), cert: certificate,
    ca: certificate, requestCert: true, rejectUnauthorized: true })
  server.on('stream', (stream: import('node:http2').ServerHttp2Stream, headers) => {
    let body = ''
    stream.setEncoding('utf8')
    stream.on('data', chunk => { body += chunk })
    stream.on('end', () => {
      const peer = (stream.session!.socket as import('node:tls').TLSSocket).getPeerCertificate()
      received = { peer: String(peer.subject.UID), path: String(headers[':path']),
        authorization: headers.authorization, topic: headers['apns-topic'], payload: JSON.parse(body) }
      stream.respond({ ':status': 200 })
      stream.end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as import('node:net').AddressInfo).port
})

afterAll(async () => {
  session?.destroy()
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  for (const name of variables) {
    if (previous[name] === undefined) delete process.env[name]
    else process.env[name] = previous[name]
  }
  mock.restore()
  rmSync(directory, { recursive: true, force: true })
})

test('loads a DER certificate and its encrypted matching private key without token credentials', () => {
  expect(loadAPNsConfiguration(env)).toHaveProperty('certificate')
  expect(getAPNsInfo()).toEqual({ configured: true, bundleId: 'chat.lumiverse.ios', reason: null, delivery: 'direct' })
  expect(JSON.stringify(getAPNsInfo())).not.toContain('PRIVATE KEY')
})

test('selects an independent provider key for Live Activities while preserving certificate alerts', () => {
  const activityKeyPath = join(directory, 'activity-key.p8')
  writeFileSync(activityKeyPath, generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'pem', type: 'pkcs8' }))
  expect(loadAPNsConfiguration(env, 'liveactivity')).toBeNull()
  const both = { ...env, APNS_LIVE_ACTIVITY_PRIVATE_KEY_PATH: activityKeyPath, APNS_TEAM_ID: 'TEAM123456', APNS_KEY_ID: 'KEY1234567' }
  expect(loadAPNsConfiguration(both)).toHaveProperty('certificate')
  const activity = loadAPNsConfiguration(both, 'liveactivity')
  expect(activity).toHaveProperty('teamId', 'TEAM123456')
  expect(activity).not.toHaveProperty('certificate')
})

test('rejects a certificate for another app or an unrelated private key', () => {
  expect(() => loadAPNsConfiguration({ ...env, APNS_BUNDLE_ID: 'another.app' })).toThrow('bundle ID')
  const wrongKey = join(directory, 'wrong-key.pem')
  writeFileSync(wrongKey, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }))
  expect(() => loadAPNsConfiguration({ ...env, APNS_PRIVATE_KEY_PATH: wrongKey })).toThrow('match its private key')
  expect(() => loadAPNsConfiguration({ APNS_CERTIFICATE_PATH: certPath })).toThrow('Invalid APNs configuration')
})

test('delivers an alert over real mutually authenticated HTTP/2 without a bearer token', async () => {
  expect(await sendAPNsNotification({ device_token: 'ab'.repeat(32), bundle_id: 'chat.lumiverse.ios',
    environment: 'development', server_origin: 'https://lumi.example' },
  { title: 'Ready', body: 'Generation complete', data: { chatId: 'chat-123' } })).toEqual({ sent: true })
  expect(lastAuthority).toBe('https://api.sandbox.push.apple.com')
  expect(received).toMatchObject({ peer: 'chat.lumiverse.ios', path: `/3/device/${'ab'.repeat(32)}`,
    topic: 'chat.lumiverse.ios', payload: { aps: { alert: { title: 'Ready' } }, chatId: 'chat-123' } })
  expect(received.authorization).toBeUndefined()
})
