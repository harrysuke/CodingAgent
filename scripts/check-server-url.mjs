/**
 * Regression check for the desktop error:
 *   "Cannot reach the agent server at http://localhost:51474 ... (failed to fetch)"
 *
 * The random port is NOT in the source - it is `free_port()` in
 * apps/desktop/src-tauri/src/lib.rs, cached in the webview's localStorage as
 * `codingagent.serverUrl`. A packaged sidecar picks a new port every launch, so
 * a cached one is dead on the next run. This exercises initConnection() with a
 * fake localStorage + Tauri IPC bridge to prove stale URLs are replaced with
 * the real server origin while user-configured URLs are preserved.
 *
 * Run: npm run check:connection   (uses tsx to import the TypeScript client)
 */
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: key => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: key => store.delete(key),
};
if (typeof navigator === 'undefined') globalThis.navigator = { userAgent: 'Node' };

const {
  connection, initConnection, normalizeServerUrl, isStaleSidecarUrl, DEFAULT_SERVER_ORIGIN,
} = await import('../apps/web/src/api/client.ts');

let checks = 0;
function ok(label, condition) {
  assert.ok(condition, label);
  checks += 1;
  console.log(`  ok  ${label}`);
}

function seed(url, auto = false) {
  store.clear();
  if (url !== null) store.set('codingagent.serverUrl', url);
  if (auto) store.set('codingagent.serverUrlAuto', '1');
  delete globalThis.window; // browser mode
}

/** Fake Tauri IPC bridge: get_server_config + get_server_status. */
function bridge(config, status) {
  globalThis.window = {
    __TAURI_INTERNALS__: {
      invoke: async (cmd) => {
        if (cmd === 'get_server_config') return config;
        if (cmd === 'get_server_status') return status;
        throw new Error(`unexpected command: ${cmd}`);
      },
    },
  };
}

const STALE = 'http://localhost:51474';
const PROPER = 'http://127.0.0.1:4317';

// --- URL helpers -----------------------------------------------------------
ok('default server origin is the npm start port', DEFAULT_SERVER_ORIGIN === PROPER);
ok('localhost is rewritten to the IPv4 loopback',
  normalizeServerUrl(`${STALE}/`) === 'http://127.0.0.1:51474');
ok('empty URL stays empty (same origin)', normalizeServerUrl('') === '');
ok('an ephemeral loopback port is recognised as a dead sidecar URL', isStaleSidecarUrl(STALE));
ok('a normal LAN URL is not treated as stale', !isStaleSidecarUrl('http://192.168.1.50:51474'));
ok('the real server port is not stale', !isStaleSidecarUrl(PROPER));

// --- Browser ---------------------------------------------------------------
seed(STALE);
await initConnection();
ok('browser drops the dead sidecar port and uses the same-origin server', connection.url === '');
ok('browser clears the stale value from storage', !store.has('codingagent.serverUrl'));

seed('http://localhost:4317');
await initConnection();
ok('browser normalises a saved localhost URL', connection.url === PROPER);

// --- tauri dev (sidecar disabled, Vite proxies /api to :4317) ---------------
seed(STALE);
bridge(null, 'external');
await initConnection();
ok('tauri dev replaces the stale port with an empty (same-origin) URL', connection.url === '');

// --- Packaged app with a failed sidecar -> npm start server -----------------
seed(STALE);
bridge(null, 'failed: agent server did not become healthy (see server.log)');
await initConnection();
ok('failed sidecar falls back to the proper server port', connection.url === PROPER);
ok('repaired URL is marked auto-generated',
  store.get('codingagent.serverUrlAuto') === '1' && store.get('codingagent.serverUrl') === PROPER);

// --- Sidecar became healthy after get_server_config timed out ---------------
seed(STALE, true);
bridge(null, 'ready http://127.0.0.1:52345');
await initConnection();
ok('late-ready sidecar URL is recovered from get_server_status', connection.url === 'http://127.0.0.1:52345');

// --- Healthy sidecar wins over any saved URL --------------------------------
seed(STALE, true);
bridge({ url: 'http://127.0.0.1:54321', token: 'setup-token' }, 'ready http://127.0.0.1:54321');
await initConnection();
ok('live sidecar URL replaces the cached random port', connection.url === 'http://127.0.0.1:54321');
ok('setup token hint is still forwarded', connection.setupTokenHint === 'setup-token');

// --- A URL the user typed in Settings > Connection is preserved -------------
seed('http://192.168.1.50:4317');
bridge(null, 'failed: agent server did not become healthy (see server.log)');
await initConnection();
ok('user-configured LAN URL is never overwritten', connection.url === 'http://192.168.1.50:4317');

console.log(`\n[connection] ${checks} passed, 0 failed`);
