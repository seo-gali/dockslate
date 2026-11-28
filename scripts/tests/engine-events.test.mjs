import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const python = process.env.DOCKSLATE_TEST_PYTHON ?? 'python';
const available = spawnSync(python, ['--version'], { windowsHide: true }).status === 0;
const source = fs.readFileSync(new URL('../../src-tauri/src/engine_events.rs', import.meta.url), 'utf8');
const follow = /const FOLLOW: &str = r#"([\s\S]*?)"#;/.exec(source)?.[1];

test('Docker events keep idle reads open for chunked and close-delimited HTTP responses', { skip: !available }, () => {
  assert.ok(follow);
  const result = spawnSync(python, ['-I', '-c', `
import http.client, socket, sys, textwrap
source = sys.stdin.read()
request = source.index("connection.request('GET', '/v' + sys.argv[1] + '/events?filters=' + filters)")
block = textwrap.dedent(source[source.index('\\n', request) + 1:source.index("        send('ready', 31)", request)])
line = b'{"Type":"container","Action":"start"}\\n'
for chunked in (True, False):
    client, server = socket.socketpair()
    client.settimeout(10)
    connection = http.client.HTTPConnection('localhost', timeout=10)
    connection.sock = client
    try:
        connection.request('GET', '/events')
        server.recv(65536)
        headers = b'Transfer-Encoding: chunked\\r\\n' if chunked else b'Connection: close\\r\\n'
        body = ('%x\\r\\n' % len(line)).encode() + line + b'\\r\\n' if chunked else line
        server.sendall(b'HTTP/1.1 200 OK\\r\\n' + headers + b'\\r\\n' + body)
        scope = {'connection': connection}
        exec(block, scope)
        assert client.gettimeout() is None
        assert scope['response'].readline(65537) == line
        scope['response'].close()
    finally:
        connection.close()
        server.close()
print('chunked and close-delimited event streams passed')
`], { input: follow, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /chunked and close-delimited event streams passed/);
});
