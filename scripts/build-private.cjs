const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Private edition requires Node.js 24 or newer');
if (process.argv.includes('--watch')) {
  console.error('Private-edition watch mode is unavailable. Run npm run build after source changes so every extension is applied.');
  process.exit(1);
}
const groups = [
  'codex-bridge-fix', 'codex-bridge-modules', 'codex-bridge-notifications',
  'codex-bridge-resume-routing', 'codex-bridge-topic-notifications', 'codex-bridge-timeout-notifications'
];
function run(args) {
  const result = spawnSync(process.execPath, args, {cwd:root, stdio:'inherit', windowsHide:true});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
const tsupRoot = path.join(root, 'node_modules', 'tsup');
const tsup = JSON.parse(fs.readFileSync(path.join(tsupRoot, 'package.json'), 'utf8'));
run([path.resolve(tsupRoot, typeof tsup.bin === 'string' ? tsup.bin : tsup.bin.tsup)]);
for (const group of groups) run([path.join(root, 'extensions', group, 'install.cjs'), root, '--apply']);
const dist = path.join(root, 'dist');
for (const entry of fs.readdirSync(dist, {withFileTypes:true})) {
  if (!entry.isFile() || !/^cli\.js\.before-[\w-]+\.bak$/.test(entry.name)) continue;
  const file = path.resolve(dist, entry.name);
  if (path.dirname(file) !== dist) throw new Error('Build backup is outside dist');
  fs.unlinkSync(file);
}
run(['--check', path.join(dist, 'cli.js')]);
console.log('Private edition built with all six extension groups.');
