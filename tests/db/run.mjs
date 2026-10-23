// Runs the database tests in a throwaway Postgres container (needs Docker).
//   node tests/db/run.mjs          run and remove the container
//   node tests/db/run.mjs --keep   leave it running (used by the API tests)
// The scheduler migration (pg_cron / pg_net / Vault) is Supabase-only and is not applied here.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = process.env.JEEL_DB_CONTAINER || 'jeel-test-db';
const IMAGE = process.env.JEEL_PG_IMAGE || 'postgres:17.5-alpine3.22';
const NET = 'jeel-test-net';
const keep = process.argv.includes('--keep');

const sh = (args, input) => {
  const r = spawnSync('docker', args, { input, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
};
const psql = (file, db = 'postgres') => sh(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-f', '-'], fs.readFileSync(file, 'utf8'));

sh(['rm', '-f', NAME]);
sh(['network', 'create', NET]);
let r = sh(['run', '-d', '--name', NAME, '--network', NET, '-e', 'POSTGRES_PASSWORD=postgres', '-e', 'TZ=UTC', '-p', '54329:5432', IMAGE]);
if (r.code !== 0) { console.error(r.out); process.exit(1); }
for (let i = 0; i < 60; i++) {
  if (sh(['exec', NAME, 'pg_isready', '-U', 'postgres']).code === 0 && sh(['exec', NAME, 'psql', '-U', 'postgres', '-c', 'select 1']).code === 0) break;
  await new Promise((res) => setTimeout(res, 500));
}

const steps = [
  ['Supabase stand-ins', path.join(root, 'tests', 'db', 'supabase-stubs.sql')],
  ...fs.readdirSync(path.join(root, 'supabase', 'migrations')).filter((f) => f.endsWith('.sql') && !f.endsWith('_reminder_cron.sql')).sort()
    .map((f) => [`migration ${f}`, path.join(root, 'supabase', 'migrations', f)])
];
for (const [label, file] of steps) {
  r = psql(file);
  if (r.code !== 0) { console.error(`✗ ${label}\n${r.out}`); if (!keep) sh(['rm', '-f', NAME]); process.exit(1); }
  console.log(`✓ ${label}`);
}

let failed = false;
if (!process.argv.includes('--no-tests')) {
  r = psql(path.join(root, 'tests', 'db', 'db.test.sql'));
  const lines = r.out.split('\n').map((l) => l.replace(/^psql:.*?NOTICE:\s*/, '').replace(/^NOTICE:\s*/, '')).filter((l) => /PASS|FAIL|ERROR|ALL DB/.test(l));
  console.log(lines.join('\n'));
  failed = r.code !== 0;
  if (failed) console.error(r.out.split('\n').filter((l) => /ERROR|LINE|DETAIL|CONTEXT|HINT/.test(l)).join('\n'));
}
if (!keep) { sh(['rm', '-f', NAME]); sh(['network', 'rm', NET]); }
process.exit(failed ? 1 : 0);
