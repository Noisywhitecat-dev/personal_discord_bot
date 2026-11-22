// 디스코드 연결 없이 WS 인증/세션 슬롯/속도 제한 동작을 확인하는 로컬 테스트. 실행: node src/wsSecurityTest.js
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const WebSocket = require('ws');

const TEST_SECRET = crypto.randomBytes(32).toString('hex');
process.env.WS_SECRET = TEST_SECRET;

const session = require('./session');
const { startWsSessionServer, createAuthRateLimiter } = require('./wsSessionServer');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function startServer(options) {
  return new Promise((resolve) => {
    const wss = startWsSessionServer(0, options);
    wss.on('listening', () => resolve({ wss, url: `ws://127.0.0.1:${wss.address().port}` }));
  });
}

// 서버가 연결을 닫을 때까지 기다렸다가 닫힘 코드를 돌려준다. 인증 메시지를 보내지 않으려면 secret에 undefined(보내지 않음)를 넘긴다.
function connectAndGetCloseCode(url, authMessage, wsOptions) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, wsOptions);
    ws.on('open', () => {
      if (authMessage !== undefined) {
        ws.send(authMessage);
      }
    });
    ws.on('close', (code) => resolve(code));
    ws.on('error', () => {});
  });
}

// 인증까지 성공해 연결이 유지되는 클라이언트를 돌려준다. 연결이 곧바로 닫히면 그 코드로 reject한다.
function connectAuthenticated(url, secret = TEST_SECRET, wsOptions) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, wsOptions);
    let settled = false;
    ws.on('open', () => {
      ws.send(JSON.stringify({ secret }));
      setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(ws);
        }
      }, 300);
    });
    ws.on('close', (code) => {
      if (!settled) {
        settled = true;
        reject(code);
      }
    });
    ws.on('error', () => {});
  });
}

function fakeSession(textChannel) {
  const played = [];
  session.endSessionForUser('nobody');
  session.startSession(
    'user-1',
    { state: { status: 'ready' }, destroy() {} },
    { state: { status: 'idle' }, play: (resource) => played.push(resource) },
    'voice-1',
    textChannel
  );
  return played;
}

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  통과: ${name}`);
  } catch (error) {
    console.error(`  실패: ${name}\n`, error);
    process.exit(1);
  }
}

async function main() {
  console.log('1) WS_SECRET 없이는 시작하지 않는다');
  await check('startWsSessionServer가 WS_SECRET이 비어 있으면 예외를 던진다', async () => {
    process.env.WS_SECRET = '';
    assert.throws(() => startWsSessionServer(0), /WS_SECRET/);
    process.env.WS_SECRET = TEST_SECRET;
  });
  // cwd를 임시 폴더로 둬서 bot/.env의 진짜 값이 dotenv로 읽히지 않게 한다.
  const entry = path.join(__dirname, 'index.js');
  for (const [label, wsSecret] of [['비어 있을 때', ''], ['아예 없을 때', undefined]]) {
    await check(`index.js는 WS_SECRET이 ${label} 오류와 함께 종료된다`, async () => {
      const env = { ...process.env, DISCORD_TOKEN: 'dummy', GUILD_ID: '1', WS_PORT: '1' };
      delete env.WS_SECRET;
      if (wsSecret !== undefined) {
        env.WS_SECRET = wsSecret;
      }
      const result = spawnSync(process.execPath, [entry], { cwd: os.tmpdir(), env, encoding: 'utf8', timeout: 15_000 });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /WS_SECRET/);
    });
  }

  // 인증 실패 5회면 해당 IP가 차단되므로, 실패 케이스는 전용 서버에서 돌려 다른 검사에 영향을 주지 않게 한다.
  const authServer = await startServer();
  const authUrl = authServer.url;

  console.log('2) 인증');
  await check('비밀키가 틀리면 4003', async () => {
    assert.equal(await connectAndGetCloseCode(authUrl, JSON.stringify({ secret: 'wrong' })), 4003);
  });
  await check('길이가 같아도 내용이 다르면 4003', async () => {
    const sameLength = 'x'.repeat(TEST_SECRET.length);
    assert.equal(await connectAndGetCloseCode(authUrl, JSON.stringify({ secret: sameLength })), 4003);
  });
  await check('secret 필드가 없거나 문자열이 아니면 4003', async () => {
    assert.equal(await connectAndGetCloseCode(authUrl, JSON.stringify({})), 4003);
    assert.equal(await connectAndGetCloseCode(authUrl, JSON.stringify({ secret: 12345 })), 4003);
  });
  await check('JSON이 아니면 4000', async () => {
    assert.equal(await connectAndGetCloseCode(authUrl, 'not json'), 4000);
  });

  authServer.wss.close();
  const { wss, url } = await startServer({ heartbeatMs: 400 });

  console.log('3) 세션');
  await check('비밀키가 맞아도 세션이 없으면 4004', async () => {
    assert.equal(await connectAndGetCloseCode(url, JSON.stringify({ secret: TEST_SECRET })), 4004);
  });

  const sent = [];
  fakeSession({ send: async (message) => sent.push(message) });
  let first;
  await check('세션이 있으면 첫 연결은 유지되고 연결 알림이 간다', async () => {
    first = await connectAuthenticated(url);
    assert.equal(first.readyState, WebSocket.OPEN);
    assert.deepEqual(sent, ['오디오 클라이언트 연결됨']);
  });
  await check('두 번째 연결은 4005로 닫히고 첫 연결은 영향받지 않는다', async () => {
    assert.equal(await connectAndGetCloseCode(url, JSON.stringify({ secret: TEST_SECRET })), 4005);
    assert.equal(first.readyState, WebSocket.OPEN);
    assert.equal(sent.length, 1);
  });
  await check('첫 연결이 끊긴 뒤에는 다시 붙을 수 있고 해제/연결 알림이 간다', async () => {
    first.close();
    await sleep(300);
    assert.deepEqual(sent, ['오디오 클라이언트 연결됨', '오디오 클라이언트 연결 해제됨']);
    const again = await connectAuthenticated(url);
    assert.equal(again.readyState, WebSocket.OPEN);
    assert.equal(sent.at(-1), '오디오 클라이언트 연결됨');
    again.close();
    await sleep(300);
  });
  await check('알림 채널 전송이 실패해도 연결은 정상 동작한다', async () => {
    fakeSession({ send: async () => { throw new Error('Missing Permissions'); } });
    const ws = await connectAuthenticated(url);
    assert.equal(ws.readyState, WebSocket.OPEN);
    ws.close();
    await sleep(300);
  });
  await check('알림 채널이 없어도(null) 연결은 정상 동작한다', async () => {
    fakeSession(null);
    const ws = await connectAuthenticated(url);
    assert.equal(ws.readyState, WebSocket.OPEN);
    ws.close();
    await sleep(300);
  });
  await check('오디오 바이너리 프레임은 플레이어 리소스로 전달된다', async () => {
    const played = fakeSession(null);
    const ws = await connectAuthenticated(url);
    ws.send(Buffer.alloc(19200));
    await sleep(200);
    assert.equal(played.length, 1);
    ws.close();
    await sleep(300);
  });
  await check('큰 메시지(maxPayload 초과)는 연결이 끊긴다', async () => {
    const ws = new WebSocket(url);
    const closed = new Promise((resolve) => ws.on('close', resolve));
    ws.on('error', () => {});
    ws.on('open', () => ws.send(Buffer.alloc(200 * 1024)));
    assert.equal(await closed, 1009);
  });

  console.log('4) 죽은 연결 정리(heartbeat)');
  await check('pong도 메시지도 없는 연결은 끊기고 슬롯이 비워진다', async () => {
    fakeSession(null);
    // autoPong을 꺼서 FIN 없이 죽은 클라이언트를 흉내낸다.
    const dead = await connectAuthenticated(url, TEST_SECRET, { autoPong: false });
    assert.equal(await connectAndGetCloseCode(url, JSON.stringify({ secret: TEST_SECRET })), 4005);
    await new Promise((resolve) => dead.on('close', resolve));
    const next = await connectAuthenticated(url);
    assert.equal(next.readyState, WebSocket.OPEN);
    next.close();
    await sleep(300);
  });
  await check('pong에 정상 응답하는 연결은 유지된다', async () => {
    fakeSession(null);
    const alive = await connectAuthenticated(url);
    await sleep(1500);
    assert.equal(alive.readyState, WebSocket.OPEN);
    alive.close();
    await sleep(300);
  });
  wss.close();

  console.log('5) 인증 실패 속도 제한');
  const limited = await startServer();
  fakeSession(null);
  await check('한도만큼 실패하면 올바른 비밀키로도 4006으로 거부된다', async () => {
    for (let i = 0; i < 5; i += 1) {
      assert.equal(await connectAndGetCloseCode(limited.url, JSON.stringify({ secret: 'wrong' })), 4003);
    }
    assert.equal(await connectAndGetCloseCode(limited.url, JSON.stringify({ secret: TEST_SECRET })), 4006);
  });
  limited.wss.close();
  const fresh = await startServer();
  await check('한도 미만 실패 뒤에는 정상 접속하고 실패 횟수가 초기화된다', async () => {
    for (let i = 0; i < 4; i += 1) {
      assert.equal(await connectAndGetCloseCode(fresh.url, JSON.stringify({ secret: 'wrong' })), 4003);
    }
    const ws = await connectAuthenticated(fresh.url);
    ws.close();
    await sleep(300);
    for (let i = 0; i < 4; i += 1) {
      assert.equal(await connectAndGetCloseCode(fresh.url, JSON.stringify({ secret: 'wrong' })), 4003);
    }
    assert.notEqual(await connectAndGetCloseCode(fresh.url, JSON.stringify({ secret: 'wrong' })), 4006);
  });
  fresh.wss.close();
  await check('차단은 시간이 지나면 풀리고 오래된 기록은 정리된다 (가짜 시계)', async () => {
    let t = 1_000_000;
    const limiter = createAuthRateLimiter(() => t);
    for (let i = 0; i < 5; i += 1) {
      limiter.recordFailure('1.2.3.4');
    }
    assert.equal(limiter.isBlocked('1.2.3.4'), true);
    assert.equal(limiter.isBlocked('5.6.7.8'), false);
    t += 61_000;
    assert.equal(limiter.isBlocked('1.2.3.4'), false);
    limiter.recordFailure('1.2.3.4');
    assert.equal(limiter.isBlocked('1.2.3.4'), false);
    limiter.prune();
  });

  console.log(`\n모든 검사 통과 (${passed}개)`);
  process.exit(0);
}

main();
