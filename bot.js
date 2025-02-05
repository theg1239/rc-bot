import {
  Client,
  GatewayIntentBits,
  Partials,
  ButtonBuilder,
  ActionRowBuilder,
  ButtonStyle,
  EmbedBuilder,
  ThreadAutoArchiveDuration,
  SelectMenuBuilder,
  ApplicationCommandOptionType
} from 'discord.js';
import * as dotenv from 'dotenv';
import { createClient } from 'redis';

dotenv.config();

const TOKEN = process.env.BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const LOBBY_CHANNEL_ID = process.env.LOBBY_CHANNEL_ID;
const REDIS_URL = process.env.REDISCLOUD_URL;
const ADMIN_USER_ID = process.env.ADMIN_USER_ID;
const LOGS_CHANNEL_ID = process.env.LOGS_CHANNEL_ID;
const AUTO_ADD_ROLE_ID = '1336115778302251058';

if (!TOKEN || !GUILD_ID || !LOBBY_CHANNEL_ID || !REDIS_URL || !ADMIN_USER_ID || !LOGS_CHANNEL_ID) {
  console.error(
    'missing one or more required environment variables: bot_token, guild_id, lobby_channel_id, rediscloud_url, admin_user_id, logs_channel_id'
  );
  process.exit(1);
}

async function logEvent(message) {
  console.log(message);
  try {
    const logsChannel = await client.channels.fetch(LOGS_CHANNEL_ID);
    if (logsChannel) {
      await logsChannel.send(message);
    }
  } catch (err) {
    console.error('error posting to logs channel:', err);
  }
}

const REDIS_KEY_TEAM_LEADERS = 'queue:teamLeaders';
const REDIS_KEY_TEAM_MEMBERS = 'queue:teamMembers';

const redisClient = createClient({ url: REDIS_URL });
redisClient.on('error', (err) => console.error('redis client error', err));
await redisClient.connect();
await logEvent('connected to redis.');

// In-memory arrays
// Each team leader: { userId, additionalNeeded, crew: [userId, ...], timestamp }
// Each team member: { userId, timestamp }
let teamLeaders = [];
let teamMembers = [];

async function loadQueues() {
  try {
    const leadersData = await redisClient.get(REDIS_KEY_TEAM_LEADERS);
    const membersData = await redisClient.get(REDIS_KEY_TEAM_MEMBERS);
    teamLeaders = leadersData ? JSON.parse(leadersData) : [];
    teamMembers = membersData ? JSON.parse(membersData) : [];
    await logEvent(`loaded queues: ${teamLeaders.length} team leader(s), ${teamMembers.length} team member(s).`);
  } catch (err) {
    console.error('error loading queues from redis:', err);
  }
}

async function updateQueuesInRedis() {
  try {
    await redisClient.set(REDIS_KEY_TEAM_LEADERS, JSON.stringify(teamLeaders));
    await redisClient.set(REDIS_KEY_TEAM_MEMBERS, JSON.stringify(teamMembers));
    await logEvent('queues updated in redis.');
  } catch (err) {
    console.error('error updating queues in redis:', err);
  }
}
await loadQueues();

async function getMemberNames(userIds) {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return userIds;
  const promises = userIds.map(async (id) => {
    try {
      const member = guild.members.cache.get(id) || (await guild.members.fetch(id));
      return member.displayName;
    } catch (err) {
      return id;
    }
  });
  return Promise.all(promises);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

client.once('ready', async () => {
  await logEvent(`logged in as ${client.user.tag}!`);

  try {
    await client.application.commands.set(
      [
        {
          name: 'admin',
          description: 'team finder admin panel',
          options: [
            {
              name: 'panel',
              type: ApplicationCommandOptionType.Subcommand,
              description: 'show admin panel'
            },
            {
              name: 'clear',
              type: ApplicationCommandOptionType.Subcommand,
              description: 'clear all queues'
            },
            {
              name: 'list',
              type: ApplicationCommandOptionType.Subcommand,
              description: 'list current queue details'
            },
            {
              name: 'match',
              type: ApplicationCommandOptionType.Subcommand,
              description: 'force a matching check'
            }
          ]
        }
      ],
      GUILD_ID
    );
    await logEvent('admin slash command registered.');
  } catch (err) {
    console.error('error registering slash commands:', err);
  }

  try {
    const channel = await client.channels.fetch(LOBBY_CHANNEL_ID);
    if (!channel) {
      await logEvent('lobby channel not found!');
      return;
    }
    const lobbyEmbed = new EmbedBuilder()
      .setTitle('reverse coding: team finder')
      .setDescription(
        'welcome!\n\nchoose an option:\n' +
        '- **join a team** if you want to join an existing team.\n' +
        '- **create a team** if you want to lead a team. (teams can have 2–4 members)'
      )
      .setColor(0x2e2f33)
      .setTimestamp(new Date())
      .setImage('https://cdn.discordapp.com/attachments/1336118454591160430/1336843175767310397/image.png');
    const joinTeamButton = new ButtonBuilder()
      .setCustomId('looking_for_team')
      .setLabel('join a team')
      .setStyle(ButtonStyle.Primary);
    const createTeamButton = new ButtonBuilder()
      .setCustomId('looking_for_members_start')
      .setLabel('create a team')
      .setStyle(ButtonStyle.Success);
    const row = new ActionRowBuilder().addComponents(joinTeamButton, createTeamButton);
    await channel.send({ embeds: [lobbyEmbed], components: [row] });
    await logEvent('lobby message posted.');
  } catch (err) {
    console.error('error posting lobby message:', err);
  }
});

async function tryMatching() {
  await logEvent('attempting to match team members with team leaders...');
  for (let i = 0; i < teamLeaders.length; i++) {
    const leader = teamLeaders[i];
    while (leader.additionalNeeded > 0 && teamMembers.length > 0) {
      const member = teamMembers.shift();
      if (!member) break;
      if (member.userId === leader.userId) continue;
      leader.crew.push(member.userId);
      leader.additionalNeeded--;
      await logEvent(`team leader ${leader.userId} recruited team member ${member.userId}`);
    }
    if (leader.additionalNeeded === 0) {
      await createTeamThread(leader);
      teamLeaders.splice(i, 1);
      i--;
      await logEvent(`team leader ${leader.userId}'s team is complete; thread created.`);
    }
  }
  await updateQueuesInRedis();
}

async function createTeamThread(leader) {
  try {
    const channel = await client.channels.fetch(LOBBY_CHANNEL_ID);
    if (!channel) return;
    const teamUserIds = [leader.userId, ...leader.crew];
    const memberNames = await getMemberNames(teamUserIds);
    const threadName = `team: ${memberNames.join(', ')}`;
    const thread = await channel.threads.create({
      name: threadName,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
      reason: 'team formed'
    });
    let missingUsers = [];
    for (const userId of teamUserIds) {
      try {
        await thread.members.add(userId);
        await logEvent(`added ${userId} to thread.`);
      } catch (err) {
        await logEvent(`could not add ${userId} to thread: ${err.message}`);
        missingUsers.push(userId);
      }
    }
    const guild = client.guilds.cache.get(GUILD_ID);
    if (guild) {
      const members = await guild.members.fetch();
      const roleMembers = members.filter(member => member.roles.cache.has(AUTO_ADD_ROLE_ID));
      for (const member of roleMembers.values()) {
        try {
          await thread.members.add(member.id);
          await logEvent(`added role member ${member.id} to thread.`);
        } catch (err) {
          await logEvent(`failed to add role member ${member.id} to thread: ${err.message}`);
        }
      }
    }
    if (missingUsers.length > 0) {
      const missingNames = await getMemberNames(missingUsers);
      await thread.send(`the following users could not be automatically added: ${missingNames.join(', ')}. please join manually.`);
    }
    const confirmEmbed = new EmbedBuilder()
      .setTitle('team confirmed')
      .setDescription(
        `team leader: **${memberNames[0]}**\nteam: **${memberNames.slice(1).join(', ')}**\n\nclick **confirm team** to finalize, or use the panel below to close the thread.`
      )
      .setColor(0x2e2f33)
      .setTimestamp(new Date())
      .setThumbnail('https://cdn.discordapp.com/attachments/1336118454591160430/1336843175767310397/image.png');
    const confirmButton = new ButtonBuilder()
      .setCustomId('confirm_team')
      .setLabel('confirm team')
      .setStyle(ButtonStyle.Success);
    const closeButton = new ButtonBuilder()
      .setCustomId('close_thread')
      .setLabel('close thread')
      .setStyle(ButtonStyle.Danger);
    const panelRow = new ActionRowBuilder().addComponents(confirmButton, closeButton);
    await thread.send({ content: memberNames.join(', '), embeds: [confirmEmbed], components: [panelRow] });
    await logEvent(`thread created for team leader ${leader.userId}`);
  } catch (error) {
    await logEvent(`error creating team thread: ${error.message}`);
  }
}

client.on('interactionCreate', async (interaction) => {
  if (interaction.isButton()) {
    if (interaction.customId === 'looking_for_team') {
      await handleLookingForTeam(interaction);
    } else if (interaction.customId === 'looking_for_members_start') {
      await handleLookingForMembersStart(interaction);
    } else if (interaction.customId === 'confirm_team') {
      await handleConfirmTeam(interaction);
    }
    else if (interaction.customId === 'close_thread') {
      try {
        const thread = interaction.channel;
        if (thread && thread.isThread()) {
          await thread.setArchived(true, 'closed via panel');
          await interaction.reply({ content: 'thread closed.', ephemeral: true });
          await logEvent(`thread ${thread.id} closed via panel by ${interaction.user.id}`);
        }
      } catch (err) {
        await interaction.reply({ content: 'error closing thread.', ephemeral: true });
        await logEvent(`error closing thread: ${err.message}`);
      }
    }
    else if (interaction.customId === 'switch_to_team') {
      teamLeaders = teamLeaders.filter(entry => entry.userId !== interaction.user.id);
      teamMembers.push({ userId: interaction.user.id, timestamp: Date.now() });
      await logEvent(`user ${interaction.user.id} switched from team leader to team member.`);
      await updateQueuesInRedis();
      const embed = new EmbedBuilder()
        .setTitle('allegiance switched')
        .setDescription('you have left your leader role and joined as a team member.')
        .setColor(0x2e2f33)
        .setTimestamp(new Date());
      await interaction.update({ embeds: [embed], components: [] });
      await tryMatching();
    } else if (interaction.customId === 'switch_to_leader') {
      teamMembers = teamMembers.filter(entry => entry.userId !== interaction.user.id);
      const selectMenu = new SelectMenuBuilder()
        .setCustomId('select_member_count')
        .setPlaceholder('select how many team members you need')
        .addOptions([
          {
            label: '1 team member (4 total)',
            description: 'need 1 more (already have 3)',
            value: '1'
          },
          {
            label: '2 team members (3 total)',
            description: 'need 2 more (already have 2)',
            value: '2'
          }
        ]);
      const row = new ActionRowBuilder().addComponents(selectMenu);
      const embed = new EmbedBuilder()
        .setTitle('team leader setup')
        .setDescription('you have switched to leader role. select how many team members you need.')
        .setColor(0x2e2f33)
        .setTimestamp(new Date());
      await interaction.update({ embeds: [embed], components: [row] });
    } else if (interaction.customId === 'cancel_switch') {
      const embed = new EmbedBuilder()
        .setTitle('switch cancelled')
        .setDescription('your allegiance remains unchanged.')
        .setColor(0x2e2f33)
        .setTimestamp(new Date());
      await interaction.update({ embeds: [embed], components: [] });
    } else if (interaction.customId === 'update_recruitment') {
      const selectMenu = new SelectMenuBuilder()
        .setCustomId('select_member_count')
        .setPlaceholder('select updated number of team members you need')
        .addOptions([
          {
            label: '1 team member (4 total)',
            description: 'need 1 more',
            value: '1'
          },
          {
            label: '2 team members (3 total)',
            description: 'need 2 more',
            value: '2'
          }
        ]);
      const row = new ActionRowBuilder().addComponents(selectMenu);
      const embed = new EmbedBuilder()
        .setTitle('update team leader recruitment')
        .setDescription('select the updated number of team members you need.')
        .setColor(0x2e2f33)
        .setTimestamp(new Date());
      await interaction.update({ embeds: [embed], components: [row] });
    }
  } else if (interaction.isCommand() && interaction.commandName === 'admin') {
    if (interaction.user.id !== ADMIN_USER_ID) {
      await interaction.reply({ content: 'you are not authorized to use admin commands.', ephemeral: true });
      return;
    }
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === 'panel') {
      await showAdminPanel(interaction);
    } else if (subcommand === 'clear') {
      teamLeaders = [];
      teamMembers = [];
      await updateQueuesInRedis();
      await logEvent('admin cleared all queues.');
      await interaction.reply({ content: 'all queues have been cleared.', ephemeral: true });
    } else if (subcommand === 'list') {
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('queue details')
            .addFields(
              { name: 'team leaders', value: `${teamLeaders.length}`, inline: true },
              { name: 'team members', value: `${teamMembers.length}`, inline: true }
            )
            .setColor(0x0099ff)
            .setTimestamp(new Date())
        ],
        ephemeral: true
      });
    } else if (subcommand === 'match') {
      await tryMatching();
      await interaction.reply({ content: 'force matching executed.', ephemeral: true });
    }
  } else if (interaction.isSelectMenu()) {
    if (interaction.customId === 'select_member_count') {
      await handleMemberCountSelect(interaction);
    }
  }
});

async function handleLookingForTeam(interaction) {
  if (!interaction.isButton()) return;
  const leaderEntry = teamLeaders.find(entry => entry.userId === interaction.user.id);
  if (leaderEntry) {
    const embed = new EmbedBuilder()
      .setTitle('switch allegiance?')
      .setDescription(
        `you are currently a team leader needing **${leaderEntry.additionalNeeded}** more team member(s). if you join as a team member, you will leave your leader role. proceed?`
      )
      .setColor(0xffa500)
      .setTimestamp(new Date());
    const switchButton = new ButtonBuilder()
      .setCustomId('switch_to_team')
      .setLabel('join as team member')
      .setStyle(ButtonStyle.Danger);
    const cancelButton = new ButtonBuilder()
      .setCustomId('cancel_switch')
      .setLabel('stay leader')
      .setStyle(ButtonStyle.Secondary);
    const row = new ActionRowBuilder().addComponents(switchButton, cancelButton);
    await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
    return;
  }
  const memberEntry = teamMembers.find(entry => entry.userId === interaction.user.id);
  if (memberEntry) {
    const embed = new EmbedBuilder()
      .setTitle('already registered')
      .setDescription('you are already registered as a team member.')
      .setColor(0x2e2f33)
      .setTimestamp(new Date());
    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }
  const embed = new EmbedBuilder()
    .setTitle('team join request received')
    .setDescription('you have been added to the queue. you will be notified when you are matched with a team.')
    .setColor(0x2e2f33)
    .setTimestamp(new Date());
  await interaction.reply({ embeds: [embed], ephemeral: true });
  teamMembers.push({ userId: interaction.user.id, timestamp: Date.now() });
  await logEvent(`user ${interaction.user.id} added as team member.`);
  await updateQueuesInRedis();
  await tryMatching();
}

async function handleLookingForMembersStart(interaction) {
  if (!interaction.isButton()) return;
  const memberEntry = teamMembers.find(entry => entry.userId === interaction.user.id);
  if (memberEntry) {
    const embed = new EmbedBuilder()
      .setTitle('switch allegiance?')
      .setDescription('you are currently registered as a team member. if you want to be a team leader, you will leave that role. proceed?')
      .setColor(0xffa500)
      .setTimestamp(new Date());
    const switchButton = new ButtonBuilder()
      .setCustomId('switch_to_leader')
      .setLabel('become leader')
      .setStyle(ButtonStyle.Success);
    const cancelButton = new ButtonBuilder()
      .setCustomId('cancel_switch')
      .setLabel('stay team member')
      .setStyle(ButtonStyle.Secondary);
    const row = new ActionRowBuilder().addComponents(switchButton, cancelButton);
    await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
    return;
  }
  const leaderEntry = teamLeaders.find(entry => entry.userId === interaction.user.id);
  if (leaderEntry) {
    const embed = new EmbedBuilder()
      .setTitle('leader status')
      .setDescription(
        `your team already has **${leaderEntry.crew.length}** members.\nteam members still needed: **${leaderEntry.additionalNeeded}**.`
      )
      .setColor(0x2e2f33)
      .setTimestamp(new Date());
    const updateButton = new ButtonBuilder()
      .setCustomId('update_recruitment')
      .setLabel('update recruitment')
      .setStyle(ButtonStyle.Primary);
    const row = new ActionRowBuilder().addComponents(updateButton);
    await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
    return;
  }
  const selectMenu = new SelectMenuBuilder()
    .setCustomId('select_member_count')
    .setPlaceholder('select number of team members needed')
    .addOptions([
      {
        label: '1 team member (4 total)',
        description: 'need 1 more (already have 3)',
        value: '1'
      },
      {
        label: '2 team members (4 total)',
        description: 'need 2 more (already have 2)',
        value: '2'
      }
    ]);
  const row = new ActionRowBuilder().addComponents(selectMenu);
  const embed = new EmbedBuilder()
    .setTitle('leader setup')
    .setDescription('select number of team members needed for your team.')
    .setColor(0x2e2f33)
    .setTimestamp(new Date());
  await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}

async function handleMemberCountSelect(interaction) {
  if (!interaction.isSelectMenu()) return;
  const selectedValue = interaction.values[0];
  const additionalNeeded = parseInt(selectedValue, 10);
  if (isNaN(additionalNeeded)) {
    await interaction.reply({ content: 'invalid selection.', ephemeral: true });
    return;
  }
  const leaderEntry = teamLeaders.find(entry => entry.userId === interaction.user.id);
  if (leaderEntry) {
    leaderEntry.additionalNeeded = additionalNeeded;
    await logEvent(`user ${interaction.user.id} updated recruitment to need ${additionalNeeded} team member(s).`);
  } else {
    teamLeaders.push({
      userId: interaction.user.id,
      additionalNeeded,
      crew: [],
      timestamp: Date.now()
    });
    await logEvent(`user ${interaction.user.id} added as leader needing ${additionalNeeded} team member(s).`);
  }
  await updateQueuesInRedis();
  await interaction.update({
    content: `you are now a team leader. you need ${additionalNeeded} more team member(s).`,
    components: []
  });
  await tryMatching();
}

async function handleConfirmTeam(interaction) {
  if (!interaction.isButton()) return;
  const embed = new EmbedBuilder()
    .setTitle('team confirmed')
    .setDescription('your team is set! may the code be with you.')
    .setColor(0x2e2f33)
    .setTimestamp(new Date());
  await interaction.reply({ embeds: [embed], ephemeral: false });
  const thread = interaction.channel;
  if (thread && thread.isThread()) {
    try {
      await thread.setArchived(true, 'team confirmed');
      await logEvent(`thread ${thread.id} archived after team confirmation.`);
    } catch (error) {
      await logEvent(`error archiving thread: ${error.message}`);
    }
  }
}

async function showAdminPanel(interaction) {
  const embed = new EmbedBuilder()
    .setTitle('admin panel')
    .setDescription('manage the team finder queues and threads.')
    .addFields(
      { name: 'team leaders', value: `${teamLeaders.length}`, inline: true },
      { name: 'team members', value: `${teamMembers.length}`, inline: true }
    )
    .setColor(0xff0000)
    .setTimestamp(new Date());
  const closeButton = new ButtonBuilder()
    .setCustomId('close_thread')
    .setLabel('close current thread')
    .setStyle(ButtonStyle.Danger);
  const row = new ActionRowBuilder().addComponents(closeButton);
  await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}

client.login(TOKEN);
