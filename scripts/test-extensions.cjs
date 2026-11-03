const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'dist', 'cli.js');
if (!fs.existsSync(source)) throw new Error('Run npm run build before test:extensions');
const extensions = path.join(root, 'extensions');
const files = [];
for (const group of fs.readdirSync(extensions, {withFileTypes:true})) {
  if (!group.isDirectory()) continue;
  for (const entry of fs.readdirSync(path.join(extensions, group.name))) {
    if (entry.endsWith('.test.cjs')) files.push(path.join(extensions, group.name, entry));
  }
}
if (!files.length) throw new Error('No extension regression tests found');
const result = spawnSync(process.execPath, ['--test', ...files.sort()], {
  cwd:root, stdio:'inherit', windowsHide:true,
  env:{...process.env, BRIDGE_PACKAGE_ROOT:root, BRIDGE_TEST_SOURCE:source}
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
