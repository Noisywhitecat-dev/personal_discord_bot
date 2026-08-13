const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('start')
    .setDescription('내가 있는 음성 채널로 봇을 불러 릴레이를 시작합니다'),
  new SlashCommandBuilder().setName('stop').setDescription('진행 중인 릴레이를 종료합니다'),
].map((command) => command.toJSON());

async function registerCommands(botToken, clientId, guildId) {
  const rest = new REST().setToken(botToken);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
}

module.exports = { registerCommands };
