import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer as createNetServer} from 'node:net';
import {once} from 'node:events';
import {mkdtemp, mkdir, readdir, copyFile, symlink, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const credentials = {API_KEY: 'fixture-read-key-'.repeat(3), CTRADER_CLIENT_ID: 'fixture-client',
  CTRADER_CLIENT_SECRET: 'fixture-client-secret-not-for-logs', CTRADER_ACCESS_TOKEN: 'fixture-access-not-for-logs'};

async function freePort() {
  const server = createNetServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function launch(t, mode, {fileValues = {}, processValues = {}, port} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'trading-startup-'));
  await mkdir(join(dir, 'src'));
  await mkdir(join(dir, 'unrelated-cwd'));
  for (const file of await readdir(join(root, 'src'))) {
    if (file.endsWith('.js')) await copyFile(join(root, 'src', file), join(dir, 'src', file));
  }
  await symlink(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
  await writeFile(join(dir, 'package.json'), '{"type":"module"}\n');
  const listenPort = port || await freePort();
  const vars = {...credentials, HOST: '127.0.0.1', PORT: String(listenPort), TRADING_ENABLED: 'false', ...fileValues};
  await writeFile(join(dir, '.env'), Object.entries(vars).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', {mode: 0o600});
  const entry = join(dir, 'src', 'server.js');
  const args = mode === 'import' ? ['--input-type=module', '-e', `import(${JSON.stringify(pathToFileURL(entry).href)})`]
    : mode === 'require' ? ['-e', `require(${JSON.stringify(entry)})`] : [entry];
  // No production environment variables or production .env enter this fixture.
  const child = spawn(process.execPath, args, {cwd: join(dir, 'unrelated-cwd'),
    env: {PATH: process.env.PATH, ...processValues}, stdio: ['ignore', 'pipe', 'pipe']});
  const state = {stdout: '', stderr: ''};
  child.stdout.on('data', (chunk) => { state.stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { state.stderr += chunk.toString(); });
  const exited = new Promise((resolve, reject) => { child.once('exit', (code) => resolve(code)); child.once('error', reject); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    try { await exited; } finally { clearTimeout(timer); await rm(dir, {recursive: true, force: true}); }
  });
  const waitForReady = () => new Promise((resolve, reject) => {
    if (state.stdout.includes('"event":"api_listening"')) return resolve();
    const timer = setTimeout(() => { cleanup(); reject(new Error('Startup did not bind an HTTP listener')); }, 5000);
    const check = () => { if (state.stdout.includes('"event":"api_listening"')) { cleanup(); resolve(); } };
    const stop = () => { cleanup(); reject(new Error(`Startup exited before listening: ${state.stderr}`)); };
    const cleanup = () => { clearTimeout(timer); child.stdout.off('data', check); child.off('exit', stop); };
    child.stdout.on('data', check); child.once('exit', stop);
    if (child.exitCode !== null) stop();
  });
  return {child, state, exited, waitForReady, url: `http://127.0.0.1:${listenPort}`};
}

for (const mode of ['direct', 'import', 'require']) {
  test(`production entry starts HTTP via ${mode} and loads .env without relying on npm start or cwd`, async (t) => {
    const app = await launch(t, mode);
    await app.waitForReady();
    const health = await fetch(app.url + '/health');
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {status: 'up', environment: 'demo', brokerConnection: 'not_checked'});
    assert.equal((await fetch(app.url + '/ready')).status, 401);
    for (const secret of Object.values(credentials)) assert.ok(!app.state.stdout.includes(secret) && !app.state.stderr.includes(secret));
  });
}

test('hosting environment values take precedence over the .env file', async (t) => {
  const app = await launch(t, 'import', {fileValues: {API_KEY: 'invalid'}, processValues: {API_KEY: credentials.API_KEY}});
  await app.waitForReady();
  assert.equal((await fetch(app.url + '/health')).status, 200);
});

test('startup configuration errors name the failed check without printing credentials', async (t) => {
  const app = await launch(t, 'import', {fileValues: {API_KEY: 'invalid'}});
  assert.equal(await app.exited, 1);
  assert.ok(app.state.stderr.includes('CONFIG_API_KEY_WEAK'));
  assert.ok(!app.state.stdout.includes('api_listening'));
  for (const secret of Object.values(credentials)) assert.ok(!app.state.stderr.includes(secret));
});

test('an occupied listener reports EADDRINUSE rather than a misleading configuration error', async (t) => {
  const blocker = createNetServer();
  blocker.listen(0, '127.0.0.1');
  await once(blocker, 'listening');
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  const app = await launch(t, 'direct', {port: blocker.address().port});
  assert.equal(await app.exited, 1);
  assert.ok(app.state.stderr.includes('EADDRINUSE'));
  assert.ok(!app.state.stdout.includes('api_listening'));
});
