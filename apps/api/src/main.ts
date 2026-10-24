import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createApi } from './server.ts';
import { Coordinator } from './coordinator.ts';

const token = process.env.AGENT_API_TOKEN ?? '';
const portText = process.env.AGENT_API_PORT ?? '4180';
if (!/^\d{1,5}$/.test(portText)) throw new Error('Invalid API port');
const port = Number(portText);
if (port < 1 || port > 65535) throw new Error('Invalid API port');
const origin = `http://127.0.0.1:${port}`;
const database = resolve(process.env.AGENT_DATABASE ?? '.agent/api.sqlite');
await mkdir(dirname(database), { recursive: true, mode: 0o700 });
const coordinator = new Coordinator(database);
let app;
try {
  app = createApi({ token, origin, store: coordinator.store, owner: 'api-local', submissions: true });
} catch (error) {
  await coordinator.close();
  throw error;
}
app.addHook('onClose', async () => coordinator.close());
const server = app;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void server.close(); });
try {
  await app.listen({ host: '127.0.0.1', port });
  console.log(`Agent API: ${origin}`);
} catch {
  await app.close();
  process.exitCode = 1;
}
