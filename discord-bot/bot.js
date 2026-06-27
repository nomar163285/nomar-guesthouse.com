require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const REPO_DIR = path.resolve(__dirname, '..');
const ASSETS_DIR = path.join(REPO_DIR, 'assets');

const PROMPT_PREFIX =
  '次の指示に従って、このリポジトリ内のファイルを編集してください。' +
  'git操作（add, commit, push）はこちらで別途行うので、あなたは行わないでください。' +
  '編集が終わったら、変更内容を日本語で短く要約してください。\n\n';

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`ダウンロード失敗: HTTP ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      })
      .on('error', reject);
  });
}

async function saveAttachments(message) {
  if (!fs.existsSync(ASSETS_DIR)) {
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
  }
  const savedPaths = [];
  for (const attachment of message.attachments.values()) {
    const ext = path.extname(attachment.name || '') || '.png';
    const safeName = `discord_${Date.now()}_${savedPaths.length}${ext}`;
    const destPath = path.join(ASSETS_DIR, safeName);
    await downloadFile(attachment.url, destPath);
    savedPaths.push(`assets/${safeName}`);
  }
  return savedPaths;
}

function runCommand(cmd, args, cwd) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { cwd, shell: false });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('close', (code) => resolve({ code, out, err }));
  });
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

client.once('ready', () => {
  console.log(`Botが起動しました: ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channel.id !== CHANNEL_ID) return;

  const instruction = message.content.trim();
  if (!instruction && message.attachments.size === 0) return;

  await message.reply('受け取りました。作業を始めます…（少し時間がかかります）');

  let savedPaths = [];
  try {
    savedPaths = await saveAttachments(message);
  } catch (e) {
    await message.reply(`添付ファイルの保存に失敗しました。\n${e.message}`);
    return;
  }

  const attachmentNote =
    savedPaths.length > 0
      ? '添付画像は以下のパスにすでに保存済みです。指示文中に元のファイル名（IMG_xxxxなど）が書かれていても無視し、' +
        `必ず次の保存済みパスを使ってください: ${savedPaths.join(', ')}\n\n`
      : '';

  const fullPrompt = PROMPT_PREFIX + attachmentNote + '指示内容: ' + instruction;

  const claude = spawn(
    process.platform === 'win32' ? 'claude.cmd' : 'claude',
    ['--print', '--permission-mode', 'bypassPermissions'],
    { cwd: REPO_DIR, shell: true }
  );

  claude.stdin.write(fullPrompt);
  claude.stdin.end();

  let output = '';
  let errorOutput = '';

  claude.stdout.on('data', (data) => {
    output += data.toString();
  });

  claude.stderr.on('data', (data) => {
    errorOutput += data.toString();
  });

  claude.on('close', async (code) => {
    if (code !== 0) {
      await message.reply(
        `エラーが発生しました（コード: ${code}）。\n${errorOutput.slice(0, 1500) || '詳細不明'}`
      );
      return;
    }

    const trimmed = output.trim() || '完了しましたが、出力がありませんでした。';
    const chunks = trimmed.match(/[\s\S]{1,1900}/g) || [trimmed];
    for (const chunk of chunks) {
      await message.reply(chunk);
    }

    const status = await runCommand('git', ['status', '--porcelain'], REPO_DIR);
    if (!status.out.trim()) {
      await message.reply('変更がなかったので、git commit / push は行いませんでした。');
      return;
    }

    await runCommand('git', ['add', '-A'], REPO_DIR);
    const commitMsg = `Discord経由の更新: ${instruction.slice(0, 50)}`;
    const commitResult = await runCommand(
      'git',
      ['commit', '-m', commitMsg],
      REPO_DIR
    );
    if (commitResult.code !== 0) {
      await message.reply(`commitに失敗しました。\n${commitResult.err.slice(0, 1000)}`);
      return;
    }

    const pushResult = await runCommand('git', ['push'], REPO_DIR);
    if (pushResult.code !== 0) {
      await message.reply(`pushに失敗しました。\n${pushResult.err.slice(0, 1000)}`);
      return;
    }

    await message.reply('反映しました。数分後にサイトに公開されます。');
  });
});

client.login(TOKEN);
