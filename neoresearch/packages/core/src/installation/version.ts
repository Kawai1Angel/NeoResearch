declare global {
  const NEORESEARCH_VERSION: string
  const NEORESEARCH_CHANNEL: string
}

export const InstallationVersion = typeof NEORESEARCH_VERSION === "string" ? NEORESEARCH_VERSION : "local"
export const InstallationChannel = typeof NEORESEARCH_CHANNEL === "string" ? NEORESEARCH_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
