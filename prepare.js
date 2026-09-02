const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const rimraf = require('rimraf');

function prepareExtension() {
  // 1. Read version from manifest.json
  const manifestPath = path.join(__dirname, 'src', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const version = manifest.version;
  const configPath = path.join(__dirname, 'config.json');
  const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
  if (fs.existsSync(configPath)) fs.copyFileSync(configPath, path.join(__dirname, 'src', 'config.json'));

  // 2. Create temp folders
  const tempFirefoxPath = path.join(__dirname, 'temp-firefox');
  fs.mkdirSync(tempFirefoxPath, { recursive: true });
  copyFolderRecursiveSync(path.join(__dirname, 'src'), tempFirefoxPath);

  // 3. Combine manifest files in temp-firefox
  const firefoxManifestTemplate = JSON.parse(fs.readFileSync(path.join(tempFirefoxPath, 'manifest.firefox.json'), 'utf8'));
  const firefoxManifest = combineManifests(manifest, firefoxManifestTemplate);
  delete firefoxManifest.action;
  delete firefoxManifest.service_worker;
  fs.writeFileSync(path.join(tempFirefoxPath, 'manifest.json'), JSON.stringify(firefoxManifest, null, 2));

  // 4. Delete manifest.firefox.json
  fs.unlinkSync(path.join(tempFirefoxPath, 'manifest.firefox.json'));

  // 5. Never package local channel mappings; inject them only for local builds.
  const apiUrl = process.env.APIURL;
  if (!apiUrl) throw new Error('APIURL is required, e.g. APIURL=https://api.example.com node prepare.js');
  replaceTokens(tempFirefoxPath, apiUrl, config);

  // 6. Archive the Firefox extension
  archiveExtension(tempFirefoxPath, `src-firefox-${version}.zip`);
}

function combineManifests(target, source) {
  const output = { ...target };
  
  for (const key in source) {
    if (source.hasOwnProperty(key)) {
      output[key] = source[key];
    }
  }
  
  return output;
}

function copyFolderRecursiveSync(srcPath, destPath) {
  const entries = fs.readdirSync(srcPath, { withFileTypes: true });
  fs.mkdirSync(destPath, { recursive: true });
  entries.forEach((entry) => {
    const src = path.join(srcPath, entry.name);
    const dest = path.join(destPath, entry.name);
    if (entry.isDirectory()) {
      copyFolderRecursiveSync(src, dest);
    } else {
      fs.copyFileSync(src, dest);
    }
  });
}

function archiveExtension(dirPath, name, dir = false) {
  const zipPath = path.join(__dirname, name);
  const zip = archiver('zip', { zlib: { level: 9 } });
  const zipStream = fs.createWriteStream(zipPath);
  zip.pipe(zipStream);
  zip.directory(dirPath, dir);
  zip.finalize();
  zipStream.on('close', () => {
    console.log(`Created ${zipPath}`);
    rimraf.sync(dirPath);
  });
}

function replaceTokens(dirPath, apiUrl, config) {
  const utilsFilePath = path.join(dirPath, 'scripts', 'utils.js');
  const utilsContent = fs.readFileSync(utilsFilePath, 'utf8');
  const replacedContent = utilsContent
    .replace(/%APIURL%/g, apiUrl)
    .replace('let kickChannelMappings = {channels: {}};', `let kickChannelMappings = ${JSON.stringify(config)};`);
  fs.writeFileSync(utilsFilePath, replacedContent);
}

prepareExtension();
