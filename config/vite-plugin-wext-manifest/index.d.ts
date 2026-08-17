import type {Plugin} from 'vite';

export interface WextManifestOptions {
	/**
	 * Path to the source `manifest.json`, relative to the Vite root.
	 */
	manifestPath: string;

	/**
	 * Whether to override the `version` field with the version from the
	 * closest `package.json` (replacing "-beta." with ".").
	 */
	usePackageJSONVersion?: boolean;
}

/**
 * Vite plugin that generates a browser-specific `manifest.json`.
 * Keys prefixed with browser/env selectors (e.g. `__chrome__service_worker`)
 * are resolved against `process.env.TARGET_BROWSER` and the current build mode.
 */
declare function wextManifest(options: WextManifestOptions): Plugin;

export default wextManifest;
