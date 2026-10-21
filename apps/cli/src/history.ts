import { parseArgs } from 'node:util';
import { RunStore } from '../../../packages/storage/src/run-store.ts';

try {
  const { values } = parseArgs({ options: {
    database: { type: 'string' }, 'run-id': { type: 'string' }, after: { type: 'string', default: '0' },
  }, strict: true, allowPositionals: false });
  if (!values.database || !values['run-id'] || !/^\d+$/.test(values.after)) throw new Error('Invalid arguments');
  const store = new RunStore(values.database, { readOnly: true });
  try {
    const run = store.get('local', values['run-id'], Number(values.after));
    if (!run) throw new Error('Run not found');
    console.log(JSON.stringify(run));
  } finally {
    store.close();
  }
} catch {
  console.error('History unavailable: supply an existing database and run ID');
  process.exitCode = 1;
}
