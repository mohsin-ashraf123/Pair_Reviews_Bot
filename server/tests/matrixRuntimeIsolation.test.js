import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('pair API loads and status reports the error when native Matrix runtime is unavailable', () => {
  const script = `
    import assert from 'node:assert/strict';
    import { register } from 'node:module';
    import express from 'express';
    const loader = 'export async function resolve(specifier, context, next) {' +
      'if (specifier.endsWith("/matrixService.js")) throw new Error("SIMULATED_MISSING_CRYPTO_LOADER");' +
      'return next(specifier, context); }';
    register('data:text/javascript,' + encodeURIComponent(loader), import.meta.url);
    const { default: router } = await import('./routes/pairs.js');
    const app = express();
    app.use('/api/pairs', router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
      const base = 'http://127.0.0.1:' + server.address().port;
      const countdown = await fetch(base + '/api/pairs/countdown');
      assert.equal(countdown.status, 200);
      const status = await fetch(base + '/api/pairs/status');
      assert.equal(status.status, 200);
      const body = await status.json();
      assert.equal(body.matrixConnected, false);
      assert.match(body.matrixError, /SIMULATED_MISSING_CRYPTO_LOADER/);
    } finally { await new Promise(resolve => server.close(resolve)); }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, MATRIX_HOMESERVER_URL: 'https://matrix.example', MATRIX_ROOM_ID: '!test:example', MATRIX_USER: '@test:example', MATRIX_PASSWORD: 'test-only' },
    encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
});
