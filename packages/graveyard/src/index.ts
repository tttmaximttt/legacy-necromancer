export { graveyard, digGraveyard, collectDependencies, registrySpec, ABANDONED_AFTER_YEARS, type GraveyardOptions, type DigInput, type Clients } from './graveyard.js';
export { dateRemains, nodeRelease, type EraInput } from './era.js';
export { NpmRegistry, type Packument } from './registry.js';
export { NpmAdvisories, OsvAdvisories, type AdvisorySource, type PackageVersion } from './advisories.js';
export { GitHubClient, githubSlug, type RepoStatus } from './github.js';
export { readLockedVersions, parseNpmLock, parseYarnLock } from './lockfile.js';
export { suggestReplacement, replacementFromMessage, KNOWN_REPLACEMENTS } from './replacements.js';
export { pool, type Fetch } from './http.js';
