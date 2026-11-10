'use strict';
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { KIT_VERSION, createManager, atomic } = require('./manager.cjs');
const LABELS = {
  installed: '已安装', 'already-installed': '已安装，无须重复修改', restored: '已恢复原版',
  interrupted: '上次安装中断，可用安装或修复自动恢复后重试', changed: '文件已有其他变化',
  compatible: '结构兼容，可以安装', 'restored-compatible': '已恢复原版，可以重新安装',
  'not-installed': '尚未安装', 'needs-adaptation': '需要适配新版',
  upgradeable: '已有旧版控制区，可直接升级为完整功能版',
};

async function main() {
  const action = process.argv[2] || 'status';
  if (!['install', 'status', 'restore', 'diagnose'].includes(action)) throw new Error('操作必须是 install、status、restore 或 diagnose');
  const manager = createManager();
  const discovered = manager.discover();
  console.log(`\nMirasim 控制区 · 一键工具包 ${KIT_VERSION}\nCodex 速度选择 + Claude Fast 开关 + Claude Ultracode 开关\n`);
  const label = target => discovered.labels?.[target] || target;
  console.log(`检测目标：${discovered.targets.map(label).join('、')}\n`);
  for (const entry of discovered.ignored || []) console.log(`跳过旧缓存 ${entry.version}：${entry.reason}`);
  if (discovered.ignored?.length) console.log('');
  const results = [];
  for (const version of discovered.targets) {
    try {
      const result = action === 'diagnose' ? manager.diagnose(version)
        : action === 'status' ? manager.inspect(version) : manager[action](version);
      const printable = { version: result.version, state: result.state, reloadRequired: result.reloadRequired };
      results.push(action === 'diagnose' ? result : printable);
      console.log(`[${label(version)}] ${LABELS[result.state] || result.state}`);
    } catch (error) {
      results.push({ version, state: error.code === 'BUNDLED_FILE_IN_USE' ? 'in-use' : 'needs-adaptation', error: { code: error.code || 'ERROR', message: error.message } });
      console.log(`[${label(version)}] 操作未完成：${error.message}`);
    }
  }
  const failed = results.some(result => result.state === 'needs-adaptation');
  const inUse = results.some(result => result.state === 'in-use');
  if (action === 'diagnose' || failed) {
    const report = {
      kitVersion: KIT_VERSION, generatedAt: new Date().toISOString(), selection: discovered,
      privacy: 'Only installed program metadata and bounded static code samples. No account credentials, conversation/session files or native Codex configuration are read.',
      results: discovered.targets.map(version => manager.diagnose(version)),
    };
    const name = `compatibility-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const diagnosticsDir = process.env.MIRASIM_CONTROLS_DIAGNOSTICS || path.join(manager.kitDir, 'diagnostics');
    const file = path.join(diagnosticsDir, name);
    atomic(file, JSON.stringify(report, null, 2) + '\n');
    console.log(`\n兼容报告已保存：${file}\n需要适配时，将此报告提供给维护者。`);
  }
  if (action === 'install' && !failed && !inUse) console.log('\n完成。请重新打开 Mirasim；运行中的旧窗口不会自动加载补丁。');
  if (action === 'restore' && !failed && !inUse) console.log('\n恢复完成。请重新打开 Mirasim。保存的速度偏好不会被此操作改写。');
  if (action === 'install') console.log('本工具不终止运行中的任务；以后 Mirasim 更新后，再双击“01-安装或修复.bat”。');
  if (failed) { console.log('\n无法确认兼容的版本不会强行打补丁。详见兼容报告。'); process.exitCode = 2; }
  else if (inUse) { console.log('\n文件仍被 Mirasim 占用。请等待任务结束，从系统托盘退出 Mirasim，再运行同一个 BAT。此次未完成安装。'); process.exitCode = 3; }
}

main().catch(error => { console.error(`\n失败：${error.message}`); process.exitCode = 1; }).finally(async () => {
  if (!process.argv.includes('--non-interactive') && process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await new Promise(resolve => rl.question('\n按回车关闭窗口…', resolve));
    rl.close();
  }
});
