const { joinVoiceChannel, createAudioPlayer, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
const session = require('./session');

async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  if (interaction.commandName === 'start') {
    await handleStart(interaction);
  } else if (interaction.commandName === 'stop') {
    await handleStop(interaction);
  }
}

async function handleStart(interaction) {
  if (session.isLocked()) {
    const current = session.getSession();
    await interaction.reply({
      content: `이미 <@${current.userId}>님이 릴레이 중입니다. 먼저 종료될 때까지 기다려주세요.`,
      ephemeral: true,
    });
    return;
  }

  const voiceState = interaction.guild.voiceStates.cache.get(interaction.user.id);
  const voiceChannel = voiceState?.channel;

  if (!voiceChannel) {
    await interaction.reply({ content: '먼저 음성 채널에 접속한 후 다시 시도해주세요.', ephemeral: true });
    return;
  }

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
  });
  await entersState(connection, VoiceConnectionStatus.Ready, 10_000);

  const loggedNetworkingInstances = new WeakSet();

  // VoiceConnectionStatus는 상위 레벨 상태다. 음성 전용 웹소켓/UDP(하트비트 등)를 다루는
  // 더 아래 계층(networking)이 조용히 죽어도 상위 상태는 Ready로 안 바뀔 수 있어서,
  // networking의 상태 변화도 별도로 남긴다.
  connection.on('stateChange', (oldState, newState) => {
    console.log(`[voice] connection 상태 변화: ${oldState.status} → ${newState.status}`);

    if (newState.networking && !loggedNetworkingInstances.has(newState.networking)) {
      loggedNetworkingInstances.add(newState.networking);
      newState.networking.on('stateChange', (oldNetState, newNetState) => {
        console.log(`[voice] networking(하위 계층) 상태 변화: ${oldNetState.code} → ${newNetState.code}`);
      });
    }
  });
  connection.on('error', (error) => {
    console.error('[voice] connection 오류:', error);
  });

  // @discordjs/voice는 연결이 끊겨도 자동으로 재연결하지 않는다. Disconnected 상태가 되면
  // 일시적인 끊김(채널 이동 등)인지 완전한 연결 끊김인지 구분해서, 일시적이면 재연결을 기다리고
  // 아니면 connection을 완전히 정리한다. (공식 문서 권장 패턴)
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      console.log('[voice] 일시적 연결 끊김에서 복구 중...');
    } catch {
      console.log('[voice] 연결을 복구할 수 없어 세션을 종료합니다.');
      connection.destroy();
    }
  });

  connection.on(VoiceConnectionStatus.Destroyed, () => {
    console.log('[voice] connection이 destroy되어 세션을 정리합니다.');
    session.clearSessionState();
  });

  const player = createAudioPlayer();
  connection.subscribe(player);
  player.on('stateChange', (oldState, newState) => {
    console.log(`[voice] player 상태 변화: ${oldState.status} → ${newState.status}`);
  });
  player.on('error', (error) => {
    console.error('오디오 재생 오류:', error);
  });

  session.startSession(interaction.user.id, connection, player, voiceChannel.id);

  await interaction.reply({
    content: `${voiceChannel.name} 채널로 릴레이를 시작합니다. Audio Relay Client를 실행해서 오디오 소스를 선택해주세요.`,
    ephemeral: true,
  });
}

async function handleStop(interaction) {
  const current = session.getSession();

  if (!current) {
    await interaction.reply({ content: '진행 중인 릴레이가 없습니다.', ephemeral: true });
    return;
  }

  if (!session.endSessionForUser(interaction.user.id)) {
    await interaction.reply({ content: '본인이 시작한 릴레이만 종료할 수 있습니다.', ephemeral: true });
    return;
  }

  await interaction.reply({ content: '릴레이를 종료했습니다.', ephemeral: true });
}

module.exports = { handleInteraction };
