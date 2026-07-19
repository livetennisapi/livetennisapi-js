/**
 * Single source of the package version.
 *
 * Kept in its own module so the client, the CLI and the exported VERSION all
 * agree, and so CI can assert it matches package.json — previously it was
 * hardcoded in index.ts and could silently drift from the published version.
 */
export const VERSION = '1.0.1';
