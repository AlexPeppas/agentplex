const fs = require('node:fs/promises');
const path = require('node:path');

async function copyCopilotRuntime(buildPath, platform, arch) {
  const sourceModules = path.resolve(__dirname, '..', 'node_modules');
  const destinationModules = path.join(buildPath, 'node_modules');
  const copied = new Set();
  const matches = (values, target) => !values || values.includes(target);
  async function copy(name) {
    if (copied.has(name)) return;
    copied.add(name);
    const source = path.join(sourceModules, name);
    const manifest = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
    await fs.cp(source, path.join(destinationModules, name), { recursive: true, dereference: true });
    for (const dependency of Object.keys(manifest.dependencies || {})) await copy(dependency);
    for (const dependency of Object.keys(manifest.optionalDependencies || {})) {
      let optional;
      try {
        optional = JSON.parse(await fs.readFile(path.join(sourceModules, dependency, 'package.json'), 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (matches(optional.os, platform) && matches(optional.cpu, arch)) await copy(dependency);
    }
  }
  await copy('@github/copilot-sdk');
  if (![...copied].some(name => name.startsWith(`@github/copilot-sdk-${platform}`) && name.endsWith(`-${arch}`))) {
    throw new Error(`Copilot SDK runtime for ${platform}-${arch} is not installed`);
  }
}

module.exports = { copyCopilotRuntime };
if (require.main === module) {
  copyCopilotRuntime(process.argv[2], process.argv[3], process.argv[4]).catch(error => {
    console.error('[package] Copilot runtime copy failed:', error);
    process.exitCode = 1;
  });
}
