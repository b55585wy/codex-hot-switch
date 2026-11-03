const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
if (!root) throw new Error('Pass a CC Switch v4.0.21 source checkout; add --apply to edit source only');
const directory = path.resolve(root, 'src-tauri');
const manifestFile = path.join(directory, 'Cargo.toml');
const libraryFile = path.join(directory, 'src', 'lib.rs');
let manifest = fs.readFileSync(manifestFile, 'utf8');
let library = fs.readFileSync(libraryFile, 'utf8');
if (!/^version\s*=\s*"4\.0\.21"/m.test(manifest)) throw new Error('Requires CC Switch v4.0.21');
const feature = 'cc-bridge-control = []';
const declaration = '#[cfg(feature = "cc-bridge-control")]\nmod cc_bridge_control;\n';
const hook = '    #[cfg(feature = "cc-bridge-control")]\n    if crate::cc_bridge_control::try_handle(app, url_str) { return true; }\n';
if (!manifest.includes(feature)) {
  if (manifest.split('[features]').length !== 2) throw new Error('Unexpected feature layout');
  manifest = manifest.replace('[features]', '[features]\n' + feature);
}
if (!library.includes('mod cc_bridge_control;')) library = declaration + library;
if (!library.includes('crate::cc_bridge_control::try_handle(app, url_str)')) {
  const start = library.indexOf('fn handle_deeplink_url(');
  const position = library.indexOf('    log::info!(', start);
  if (start < 0 || position < 0 || position - start > 700) throw new Error('Unexpected deep-link handler layout');
  library = library.slice(0, position) + hook + '\n' + library.slice(position);
}
if (process.argv.includes('--apply')) {
  fs.copyFileSync(path.join(__dirname, 'cc-bridge-control.rs'), path.join(directory, 'src', 'cc_bridge_control.rs'));
  fs.writeFileSync(manifestFile, manifest);
  fs.writeFileSync(libraryFile, library);
}
console.log(JSON.stringify({applied:process.argv.includes('--apply'), target:'CC Switch v4.0.21 source', defaultEnabled:false}));
