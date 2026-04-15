import type { Provider } from './providers/provider.js';
import type { ProjectConfig } from './types.js';

/**
 * Config parser — delegates to the active provider.
 */
export function parseProjectConfig(provider: Provider, projectRoot: string): ProjectConfig {
  return provider.parseProjectConfig(projectRoot);
}
