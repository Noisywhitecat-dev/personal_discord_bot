// 디스코드 연결 없이 접속 코드 인증/세션 슬롯/속도 제한 동작을 확인하는 로컬 테스트. 실행: node src/wsSecurityTest.js
const assert = require('node:assert/strict');
const WebSocket = require('ws');

const session = require('./session');
const { startWsSessionServer, createAuthRateLimiter } = require('./wsSessionServer');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function startServer(options) {
  return new Promise((resolve) => {
    const wss = startWsSessionServer(0, options);
    wss.on('listening', () => resolve({ wss, url: `ws://127.0.0.1:${wss.address().port}` }));
  });
}

// 서버가 연결을 닫을 때까지 기다렸다가 닫힘 코드를 돌려준다.
function connectAndGetCloseCode(url, authMessage, wsOptions) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, wsOptions);
    ws.on('open', () => ws.send(authMessage));
    ws.on('close', (code) => resolve(code));
    ws.on('error', () => {});
  });
}

const authWith = (code) => JSON.stringify({ code });

// 인증까지 성공해 연결이 유지되는 클라이언트를 돌려준다. 연결이 곧바로 닫히면 그 코드로 reject한다.
function connectAuthenticated(url, code, wsOptions) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, wsOptions);
    let settled = false;
    ws.on('open', () => {
      ws.send(authWith(code));
      setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(ws);
        }
      }, 300);
    });
    ws.on('close', (c) => {
      if (!settled) {
        settled = true;
        reject(c);
      }
    });
    ws.on('error', () => {});
  });
}

// 가짜 세션을 시작하고 첫 접속 코드를 발급해 돌려준다.
function fakeSession(textChannel) {
  const played = [];
  session.endSessionForUser('user-1');
  session.startSession(
    'user-1',
    { state: { status: 'ready' }, destroy() {} },
    { state: { status: 'idle' }, play: (resource) => played.push(resource) },
    'voice-1',
    textChannel
  );
  return { played, code: session.issueJoinCode() };
}

const wrongCodeFor = (code) => (code === '000000' ? '000001' : '000000');

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
  // 인증 실패 5회면 해당 IP가 차단되므로, 실패 케이스는 전용 서버에서 돌려 다른 검사에 영향을 주지 않게 한다.
  const authServer = await startServer();

  console.log('1) 접속 코드 형식/불일치');
  await check('세션이 없으면 어떤 코드든 4004', async () => {
    assert.equal(await connectAndGetCloseCode(authServer.url, authWith('123456')), 4004);
  });
  const withSession = fakeSession(null);
  await check('코드가 틀리면 4003', async () => {
    assert.equal(await connectAndGetCloseCode(authServer.url, authWith(wrongCodeFor(withSession.code))), 4003);
  });
  await check('code 필드가 없거나 문자열이 아니거나 길이가 다르면 4003', async () => {
    assert.equal(await connectAndGetCloseCode(authServer.url, JSON.stringify({})), 4003);
    assert.equal(await connectAndGetCloseCode(authServer.url, authWith(123456)), 4003);
    assert.equal(await connectAndGetCloseCode(authServer.url, authWith('12345')), 4003);
  });
  authServer.wss.close();
  // 앞 검사들이 이 서버의 실패 한도 대부분을 썼으므로 나머지는 새 서버에서 확인한다.
  const authServer2 = await startServer();
  await check('예전 방식(secret 필드)으로 접속하면 4003', async () => {
    assert.equal(await connectAndGetCloseCode(authServer2.url, JSON.stringify({ secret: 'anything' })), 4003);
  });
  await check('JSON이 아니면 4000', async () => {
    assert.equal(await connectAndGetCloseCode(authServer2.url, 'not json'), 4000);
  });
  authServer2.wss.close();

  const { wss, url } = await startServer({ heartbeatMs: 400 });

  console.log('2) 일회용 코드와 세션 슬롯');
  const sent = [];
  let current = fakeSession({ send: async (message) => sent.push(message) });
  let first;
  await check('올바른 코드로 접속하면 유지되고 연결 알림이 간다', async () => {
    first = await connectAuthenticated(url, current.code);
    assert.equal(first.readyState, WebSocket.OPEN);
    assert.deepEqual(sent, ['오디오 클라이언트 연결됨']);
  });
  await check('이미 연결된 동안 두 번째 연결은 4005이고 첫 연결은 영향받지 않는다', async () => {
    const secondCode = session.issueJoinCode();
    assert.equal(await connectAndGetCloseCode(url, authWith(secondCode)), 4005);
    assert.equal(first.readyState, WebSocket.OPEN);
    assert.equal(sent.length, 1);
    // 4005로 거부된 연결은 코드를 소모하지 않았으므로 첫 연결이 끊긴 뒤에는 이 코드로 붙을 수 있다.
    first.close();
    await sleep(300);
    assert.deepEqual(sent, ['오디오 클라이언트 연결됨', '오디오 클라이언트 연결 해제됨']);
    const again = await connectAuthenticated(url, secondCode);
    assert.equal(again.readyState, WebSocket.OPEN);
    again.close();
    await sleep(300);
  });
  await check('한 번 쓴 코드는 다시 쓸 수 없다 (4003)', async () => {
    current = fakeSession(null);
    const ws = await connectAuthenticated(url, current.code);
    ws.close();
    await sleep(300);
    assert.equal(await connectAndGetCloseCode(url, authWith(current.code)), 4003);
  });
  await check('새 코드를 발급하면 이전 코드는 무효가 된다 (세션 주인 재 /start)', async () => {
    current = fakeSession(null);
    const oldCode = current.code;
    const newCode = session.issueJoinCode();
    assert.notEqual(oldCode, newCode);
    assert.equal(await connectAndGetCloseCode(url, authWith(oldCode)), 4003);
    const ws = await connectAuthenticated(url, newCode);
    assert.equal(ws.readyState, WebSocket.OPEN);
    ws.close();
    await sleep(300);
  });
  await check('코드는 10분이 지나면 만료되고, 세션이 바뀌면 이전 세션의 코드는 쓸 수 없다 (가짜 시계)', async () => {
    fakeSession(null);
    let t = 5_000_000;
    const code = session.issueJoinCode(() => t);
    assert.equal(session.useJoinCode(wrongCodeFor(code), () => t), 'wrong');
    assert.equal(session.useJoinCode(code, () => t + 10 * 60_000 + 1), 'expired');
    const code2 = session.issueJoinCode(() => t);
    assert.equal(session.useJoinCode(code2, () => t + 9 * 60_000), 'ok');
    assert.equal(session.useJoinCode(code2, () => t + 9 * 60_000), 'used');

    const stale = session.issueJoinCode();
    const next = fakeSession(null); // 새 세션 시작: 이전 세션의 코드는 이 세션에서 통하지 않는다
    assert.notEqual(stale, next.code);
    assert.equal(session.useJoinCode(stale), 'wrong');
  });
  await check('틀린 시도가 한도(100회)에 이르면 코드가 무효화되고 맞는 코드도 거부된다', async () => {
    fakeSession(null);
    const code = session.issueJoinCode();
    const wrong = wrongCodeFor(code);
    for (let i = 0; i < session.JOIN_CODE_MAX_FAILURES - 1; i += 1) {
      assert.equal(session.useJoinCode(wrong), 'wrong');
    }
    assert.equal(session.useJoinCode(wrong), 'locked_now');
    assert.equal(session.useJoinCode(code), 'locked');
  });
  await check('한도에 도달시킨 시도는 세션 채널에 알림이 간다', async () => {
    const notices = [];
    current = fakeSession({ send: async (message) => notices.push(message) });
    for (let i = 0; i < session.JOIN_CODE_MAX_FAILURES - 1; i += 1) {
      session.useJoinCode(wrongCodeFor(current.code));
    }
    assert.equal(await connectAndGetCloseCode(url, authWith(wrongCodeFor(current.code))), 4003);
    await sleep(200);
    assert.equal(notices.length, 1);
    assert.match(notices[0], /무효화/);
  });
  await check('알림 채널 전송이 실패해도 연결은 정상 동작한다', async () => {
    current = fakeSession({ send: async () => { throw new Error('Missing Permissions'); } });
    const ws = await connectAuthenticated(url, current.code);
    assert.equal(ws.readyState, WebSocket.OPEN);
    ws.close();
    await sleep(300);
  });
  await check('알림 채널이 없어도(null) 연결은 정상 동작한다', async () => {
    current = fakeSession(null);
    const ws = await connectAuthenticated(url, current.code);
    assert.equal(ws.readyState, WebSocket.OPEN);
    ws.close();
    await sleep(300);
  });
  await check('오디오 바이너리 프레임은 플레이어 리소스로 전달된다', async () => {
    current = fakeSession(null);
    const ws = await connectAuthenticated(url, current.code);
    ws.send(Buffer.alloc(19200));
    await sleep(200);
    assert.equal(current.played.length, 1);
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

  console.log('3) 죽은 연결 정리(heartbeat)');
  await check('pong도 메시지도 없는 연결은 끊기고 슬롯이 비워진다', async () => {
    current = fakeSession(null);
    // autoPong을 꺼서 FIN 없이 죽은 클라이언트를 흉내낸다.
    const dead = await connectAuthenticated(url, current.code, { autoPong: false });
    assert.equal(await connectAndGetCloseCode(url, authWith(session.issueJoinCode())), 4005);
    await new Promise((resolve) => dead.on('close', resolve));
    const next = await connectAuthenticated(url, session.issueJoinCode());
    assert.equal(next.readyState, WebSocket.OPEN);
    next.close();
    await sleep(300);
  });
  await check('pong에 정상 응답하는 연결은 유지된다', async () => {
    current = fakeSession(null);
    const alive = await connectAuthenticated(url, current.code);
    await sleep(1500);
    assert.equal(alive.readyState, WebSocket.OPEN);
    alive.close();
    await sleep(300);
  });
  wss.close();

  console.log('4) 인증 실패 속도 제한');
  const limited = await startServer();
  current = fakeSession(null);
  await check('한도만큼 실패하면 올바른 코드로도 4006으로 거부된다', async () => {
    for (let i = 0; i < 5; i += 1) {
      assert.equal(await connectAndGetCloseCode(limited.url, authWith(wrongCodeFor(current.code))), 4003);
    }
    assert.equal(await connectAndGetCloseCode(limited.url, authWith(current.code)), 4006);
  });
  limited.wss.close();
  const fresh = await startServer();
  await check('한도 미만 실패 뒤에는 정상 접속하고 실패 횟수가 초기화된다', async () => {
    current = fakeSession(null);
    for (let i = 0; i < 4; i += 1) {
      assert.equal(await connectAndGetCloseCode(fresh.url, authWith(wrongCodeFor(current.code))), 4003);
    }
    const ws = await connectAuthenticated(fresh.url, current.code);
    ws.close();
    await sleep(300);
    for (let i = 0; i < 4; i += 1) {
      assert.equal(await connectAndGetCloseCode(fresh.url, authWith(wrongCodeFor(current.code))), 4003);
    }
    assert.notEqual(await connectAndGetCloseCode(fresh.url, authWith(wrongCodeFor(current.code))), 4006);
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
