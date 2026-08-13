# Discord Audio Relay Bot
특정 디스코드 서버(길드) 전용으로 동작하는 오디오 릴레이 봇입니다.
길드원 누구나 본인 컴퓨터에서 재생 중인 오디오 소스(브라우저, 음악 스트리밍 앱 등) 하나를 선택해
지정된 음성 채널로 실시간 송출할 수 있습니다. 게임 중 노래를 공유하는 용도를 전제로 설계되었습니다.

> 비공개 프로젝트입니다. 공개 배포나 다른 서버에서의 사용을 목적으로 하지 않습니다.

## 개요
- 단일 길드에서만 동작
- 한 번에 한 명만 송출 가능 (선점 시 다른 사용자의 요청은 거부됨)
- 길드원은 봇 토큰 없이, 개인 인증 토큰만으로 로컬 클라이언트를 통해 오디오 송출
- 오디오 캡처는 앱 단위(예: 브라우저 탭, 음악 앱)로 선택 가능 — 시스템 전체 소리가 아님

## 길드원용 사용법
개발자가 아니어도 아래만 하면 됩니다.

1. **[Audio Relay Client 다운로드](https://github.com/Noisywhitecat-dev/personal_discord_bot/releases/latest/download/AudioRelayClientGui.exe)** — 위 링크를 클릭하면 `AudioRelayClientGui.exe`가 바로 받아집니다. (설치 불필요, 실행 파일 하나뿐)
2. 디스코드에서 노래를 공유하고 싶은 음성 채널에 먼저 접속
3. 채팅창에 `/start` 입력
4. 방금 받은 `AudioRelayClientGui.exe` 실행
5. 목록에서 소리를 보낼 앱(브라우저, 음악 앱 등)을 선택하고 **시작** 클릭
6. 끝낼 때는 디스코드에서 `/stop` 입력 (또는 그냥 음성 채널에서 나가도 자동 종료됨)

> 서버 주소나 비밀키를 입력할 필요는 없습니다 — 배포된 실행 파일에 이미 설정되어 있습니다.

## 아키텍처
```
[로컬 클라이언트 A] 오디오 캡처 → WebSocket 전송 ─┐
[로컬 클라이언트 B] 오디오 캡처 → WebSocket 전송 ─┼→ [중앙 릴레이 봇] → 디스코드 음성 채널
[로컬 클라이언트 ...]                              ─┘   (세션 잠금 관리)
```
- **로컬 클라이언트**: 각 사용자의 Windows PC에서 실행. 특정 프로세스의 오디오만 캡처해 중앙 봇으로 전송
- **중앙 릴레이 봇**: 클라우드에 24/7 상주. 디스코드 음성 채널에 접속해 있다가, 인증된 클라이언트가 보내는 오디오를 그대로 송출. 동시에 한 명만 송출 가능하도록 세션 상태 관리

## 기술 스택
| 컴포넌트 | 스택 |
|---|---|
| 중앙 릴레이 봇 | Node.js, discord.js, @discordjs/voice, ws |
| 로컬 클라이언트 | C# (.NET), Windows Process Loopback Capture API |
| 호스팅 | Oracle Cloud Always Free (ARM) |
| 통신 | WebSocket (wss), Opus 오디오 인코딩 |

## 프로젝트 구조 (예정)
```
/bot            중앙 릴레이 봇 (Node.js)
/client         로컬 클라이언트 - 콘솔 버전 (C#/.NET)
/client-gui     로컬 클라이언트 - GUI 버전 (C#/.NET, WinForms) — 길드원 배포용
/docs           설계 문서, 프로토콜 명세
README.md
```

## 개발 로드맵
- [ ] 1단계 — 봇이 음성 채널에서 로컬 테스트 파일 재생
- [ ] 2단계 — 시스템 오디오 캡처 → 봇 재생 (로컬, 앱 분리 없이)
- [ ] 3단계 — Process Loopback API로 특정 앱만 캡처
- [ ] 4단계 — 클라이언트-봇 네트워크 분리 (WebSocket 계층)
- [ ] 5단계 — 다중 사용자 인증 + 세션 잠금
- [ ] 6단계 — Oracle Cloud 배포 및 실사용 테스트

## 시작하기
> 개발 초기 단계로, 설정 방법은 추후 업데이트됩니다.

### 요구 사항
- Node.js 22 이상 (LTS 권장)
- .NET 8 SDK
- 디스코드 봇 토큰 (개발용 별도 애플리케이션 사용 권장)

### 환경 변수 설정 (bot)
`bot/.env`는 토큰 등 민감한 값을 담고 있어 git에 커밋되지 않습니다(`.gitignore`에 `.env` 규칙 있음).

```bash
cd bot
cp .env.example .env
```

이후 `bot/.env`를 열어 `DISCORD_TOKEN`, `GUILD_ID`, `VOICE_CHANNEL_ID` 등 값을 채워주세요.

### GUI 클라이언트 배포용 빌드 (관리자용)
`client-gui/secrets.local.json`(gitignore 대상, `secrets.local.json.example` 참고)에 실제 서버 주소와 `WS_SECRET`을 넣어두면 빌드 시 실행 파일에 내장됩니다.

```bash
cd client-gui
dotnet publish -c Release -p:PublishProfile=win-x64
```

`bin/Release/net9.0-windows10.0.19041.0/publish/win-x64/AudioRelayClientGui.exe` 파일 하나만 생성되며, .NET 런타임 설치 없이 그 파일 하나로 실행됩니다. 이 파일을 GitHub Release에 `AudioRelayClientGui.exe`라는 이름으로 첨부하면 위 "길드원용 사용법"의 다운로드 링크가 자동으로 최신 파일을 가리킵니다.

## 라이선스
비공개 개인/길드 프로젝트로, 별도 라이선스를 지정하지 않습니다.
