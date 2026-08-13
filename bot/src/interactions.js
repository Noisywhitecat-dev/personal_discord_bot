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

  const player = createAudioPlayer();
  connection.subscribe(player);
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

  await interaction.reply('릴레이를 종료했습니다.');
}

module.exports = { handleInteraction };
