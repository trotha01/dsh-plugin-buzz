import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';

// One database per identity and relay. Commit before invoking a model or publishing.
export class DeliveryLedger {
  constructor(file) {
    this.lease = file === ':memory:' ? undefined : new DatabaseSync(`${file}.lease`);
    try { if (this.lease) { chmodSync(`${file}.lease`, 0o600); this.lease.exec('BEGIN EXCLUSIVE'); } }
    catch { this.lease?.close(); throw new Error('Another listener owns this delivery ledger'); }
    this.db = new DatabaseSync(file);
    if (file !== ':memory:') chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    // A process may have died after tool side effects. Never blindly rerun these turns.
    for (const row of this.list()) if (row.state === 'started') this.put(row.id, {state: 'uncertain', reason: 'process_interrupted'});
  }
  get(id) { const r = this.db.prepare('SELECT data FROM deliveries WHERE id=?').get(id); return r && JSON.parse(r.data); }
  put(id, patch) {
    const row = {...this.get(id), ...patch, id, updatedAt: Date.now()};
    this.db.prepare('INSERT OR REPLACE INTO deliveries VALUES (?,?)').run(id, JSON.stringify(row));
    return row;
  }
  list() { return this.db.prepare('SELECT data FROM deliveries ORDER BY rowid').all().map(r => JSON.parse(r.data)); }
  cursor(initial) {
    const r = this.db.prepare("SELECT value FROM metadata WHERE key='cursor'").get();
    if (r) return Number(r.value);
    this.db.prepare("INSERT INTO metadata VALUES ('cursor',?)").run(String(initial));
    return initial;
  }
  checkpoint(time) { this.db.prepare("UPDATE metadata SET value=? WHERE key='cursor'").run(String(time)); }
  close() { this.db.close(); this.lease?.close(); }
}

/** Publish exactly the persisted signed event; an ambiguous ACK can safely be retried. */
export function publishSigned({relayUrl, secretHex, event, signEvent, WebSocketImpl = globalThis.WebSocket, timeoutMs = 45_000}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocketImpl(relayUrl.replace(/^http/, 'ws').replace(/\/+$/, ''));
    let done = false, authId;
    const finish = (err) => { if (done) return; done = true; clearTimeout(timer); try { ws.close(); } catch {} err ? reject(err) : resolve(event.id); };
    const timer = setTimeout(() => finish(new Error('Relay acknowledgement timeout')), timeoutMs);
    ws.addEventListener('open', () => ws.send(JSON.stringify(['EVENT', event])));
    ws.addEventListener('error', () => finish(new Error('Relay connection failed')));
    ws.addEventListener('close', () => finish(new Error('Relay closed before acknowledgement')));
    ws.addEventListener('message', ({data}) => {
      let m; try { m = JSON.parse(String(data)); } catch { return; }
      if (m[0] === 'AUTH') {
        const auth = signEvent(secretHex, {kind: 22242, tags: [['relay', relayUrl.replace(/^http/, 'ws').replace(/\/+$/, '')], ['challenge', m[1]]]});
        authId = auth.id; ws.send(JSON.stringify(['AUTH', auth]));
      } else if (m[0] === 'OK' && m[1] === authId && m[2] === true) ws.send(JSON.stringify(['EVENT', event]));
      else if (m[0] === 'OK' && m[1] === event.id) {
        if (m[2] === true || String(m[3]).startsWith('duplicate:')) finish();
        else if (!String(m[3]).startsWith('auth-required:')) finish(new Error(`Relay refused publication: ${String(m[3]).slice(0, 120)}`));
      }
    });
  });
}
