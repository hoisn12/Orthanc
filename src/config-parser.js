/**
 * Config parser — delegates to the active provider.
 */
export function parseProjectConfig(provider, projectRoot) {
  return provider.parseProjectConfig(projectRoot);
}
