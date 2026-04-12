import path from 'node:path';

/**
 * Install hooks using the given provider.
 * Kept as thin wrappers for backward compatibility and CLI mode.
 */
export function installHooks(provider, projectRoot, port = 7432, options = {}) {
  return provider.installHooks(projectRoot, port, options);
}

export function uninstallHooks(provider, projectRoot, options = {}) {
  return provider.uninstallHooks(projectRoot, options);
}

// CLI mode: node src/hook-installer.js --install|--uninstall --project /path [--port 7432] [--provider claude|codex]
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const { detectProvider } = await import('./providers/registry.js');
  const args = process.argv.slice(2);

  function getArg(name, defaultValue) {
    const idx = args.indexOf(name);
    if (idx === -1) return defaultValue;
    return args[idx + 1];
  }

  const project = getArg('--project', process.cwd());
  const port = parseInt(getArg('--port', '7432'), 10);
  const providerName = getArg('--provider', 'auto');
  const provider = detectProvider({ provider: providerName, projectRoot: project });

  if (args.includes('--uninstall')) {
    const result = uninstallHooks(provider, project);
    console.log(`Removed ${result.removed} monitor hooks from ${result.path}`);
  } else if (args.includes('--install')) {
    const result = installHooks(provider, project, port);
    console.log(`Installed ${result.installed} monitor hooks to ${result.path}`);
  } else {
    console.log('Usage: node src/hook-installer.js --install|--uninstall --project /path [--port 7432] [--provider claude|codex]');
  }
}
