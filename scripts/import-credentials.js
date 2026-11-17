import {readFile, writeFile, chmod, access} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';

// Explicit paths only. Values are never printed or passed as shell arguments.
try {
  const [source, accountSource] = process.argv.slice(2);
  if (!source || !accountSource) throw new Error('usage');
  const target = resolve('.env');
  let exists = false;
  try { await access(target); exists = true; } catch { /* File absent. */ }
  if (exists) throw new Error('exists');
  const lines = (await readFile(source, 'utf8')).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const pick = (name) => {
    const indexes = lines.flatMap((line, index) => new RegExp(`^${name}\\s*:?$`, 'i').test(line) ? [index] : []);
    return indexes.length ? lines[indexes[0] + 1] : null;
  };
  const clientId = pick('Client ID');
  const clientSecret = pick('(?:Client )?Secret');
  const accessToken = pick('Access token');
  const refreshToken = pick('Refresh token');
  const accountLines = await readFile(accountSource, 'utf8');
  // A cTID email/password is not a trading account login and is not used by OAuth.
  const numericLogin = accountLines.match(/^\s*Usuario\s*[:=]\s*([1-9]\d{0,14})\s*$/im)?.[1];
  for (const value of [clientId, clientSecret, accessToken, refreshToken]) {
    if (!value || /\s|["'`$#\\]/.test(value)) throw new Error('format');
  }
  const template = await readFile('.env.example', 'utf8');
  const values = {API_KEY: randomBytes(32).toString('hex'), TRADING_API_KEY: randomBytes(32).toString('hex'),
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'), CTRADER_CLIENT_ID: clientId,
    CTRADER_CLIENT_SECRET: clientSecret, CTRADER_ACCESS_TOKEN: accessToken, CTRADER_REFRESH_TOKEN: refreshToken};
  if (numericLogin) values.CTRADER_ACCOUNT_LOGIN = numericLogin;
  const output = template.replace(/^([A-Z_]+)=.*$/gm, (line, key) => Object.hasOwn(values, key) ? `${key}=${values[key]}` : line);
  await writeFile(target, output, {mode: 0o600, flag: 'wx'});
  await chmod(target, 0o600);
  console.log('Created private .env with OAuth credentials and independent API keys. Values hidden.');
  console.log('The first OAuth token pair in the source was imported; scope and validity must be checked against the broker.');
} catch (error) {
  console.error(error.message === 'exists' ? '.env already exists; not overwritten.' : 'Credential import failed; check the source format and paths. No values were printed.');
  process.exitCode = 1;
}
