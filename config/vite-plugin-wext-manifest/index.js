/**
 * Localized Vite plugin for generating browser-specific `manifest.json`.
 *
 * Behavior (unchanged from the original):
 *  1. Reads `manifest.json` from the Vite root.
 *  2. Recursively resolves keys prefixed with browser/env selectors, e.g.
 *     `__chrome__service_worker`, `__firefox__background_scripts`, `__dev__...`, `__prod__...`.
 *     Keys whose selector does not match the current target are dropped.
 *  3. Optionally overrides `version` with the closest `package.json` version.
 *  4. Emits the final `manifest.json` into the build output.
 */

import path from 'node:path';
import fs from 'node:fs/promises';

// ---------------------------------------------------------------------------
// wext-manifest-transformer: constants
// ---------------------------------------------------------------------------

const ENVKeys = {
	DEV: 'dev',
	PROD: 'prod',
};

const Browser = {
	CHROME: 'chrome',
	FIREFOX: 'firefox',
	EDGE: 'edge',
	BRAVE: 'brave',
	OPERA: 'opera',
	VIVALDI: 'vivaldi',
	ARC: 'arc',
	YANDEX: 'yandex',
};

const browserVendors = Object.values(Browser);
const envVariables = [ENVKeys.DEV, ENVKeys.PROD];

const CUSTOM_PREFIX_REGEX = new RegExp(
	`^__((?:(?:${[...browserVendors, ...envVariables].join('|')})\\|?)+)__(.*)`
);

// ---------------------------------------------------------------------------
// wext-manifest-transformer: transformer
// ---------------------------------------------------------------------------

/**
 * Recursively keeps/drops manifest entries based on the selected browser
 * vendor and the current node environment.
 *
 * @param {unknown} manifest - manifest object (or value) to transform
 * @param {string} selectedVendor - target browser, e.g. "chrome"
 * @param {string} nodeEnv - "production" | "development"
 * @returns {unknown} transformed manifest
 */
const transformer = (manifest, selectedVendor, nodeEnv) => {
	if (Array.isArray(manifest)) {
		return manifest.map((entry) =>
			transformer(entry, selectedVendor, nodeEnv)
		);
	}

	if (typeof manifest === 'object' && manifest !== null) {
		return Object.entries(manifest).reduce((result, [key, value]) => {
			const vendorMatch = key.match(CUSTOM_PREFIX_REGEX);

			if (vendorMatch) {
				const matches = vendorMatch[1]?.split('|') || [];
				const isProd = nodeEnv === 'production';
				const hasCurrentVendor = matches.includes(selectedVendor);
				const hasVendorKeys = matches.some((match) =>
					browserVendors.includes(match)
				);
				const hasEnvKey = matches.some((match) =>
					envVariables.includes(match)
				);
				const hasCurrentEnvKey =
					hasEnvKey &&
					((isProd && matches.includes(ENVKeys.PROD)) ||
						(!isProd && matches.includes(ENVKeys.DEV)));

				if (
					(hasCurrentVendor && hasCurrentEnvKey) ||
					(!hasVendorKeys && hasCurrentEnvKey) ||
					(!hasEnvKey && hasCurrentVendor)
				) {
					result[vendorMatch[2]] = transformer(
						value,
						selectedVendor,
						nodeEnv
					);
				}
			} else {
				result[key] = transformer(value, selectedVendor, nodeEnv);
			}

			return result;
		}, {});
	}

	return manifest;
};

// ---------------------------------------------------------------------------
// helpers (replacing find-up-simple / load-json-file / read-pkg)
// ---------------------------------------------------------------------------

/** Reads and parses a JSON file. */
const loadJsonFile = async (filePath) => {
	const raw = await fs.readFile(filePath, 'utf-8');
	return JSON.parse(raw);
};

/** Walks up from `startDir` until a `package.json` is found. */
const findUpPackageJson = async (startDir) => {
	let dir = startDir;

	// eslint-disable-next-line no-constant-condition
	while (true) {
		const candidate = path.join(dir, 'package.json');
		try {
			await fs.access(candidate);
			return candidate;
		} catch {
			const parent = path.dirname(dir);
			if (parent === dir) {
				return null;
			}
			dir = parent;
		}
	}
};

// ---------------------------------------------------------------------------
// vite plugin
// ---------------------------------------------------------------------------

const PLUGIN_NAME = 'wext-manifest';

/**
 * @typedef {Object} WextManifestOptions
 * @property {string} manifestPath - path to the source manifest.json (relative to Vite root)
 * @property {boolean} [usePackageJSONVersion] - whether to override `version` from the closest package.json
 */

/**
 * Vite plugin that resolves browser/env-prefixed manifest.json keys.
 *
 * @param {WextManifestOptions} options
 * @returns {import('vite').Plugin}
 */
export default function wextManifest(options) {
	if (!options?.manifestPath) {
		throw new Error(`${PLUGIN_NAME}: \`manifestPath\` option is required.`);
	}

	let config;

	return {
		name: PLUGIN_NAME,

		configResolved(resolvedConfig) {
			config = resolvedConfig;
		},

		async buildStart() {
			const {mode, root} = config;
			const targetBrowser = process.env.TARGET_BROWSER;

			if (!targetBrowser) {
				this.error('`TARGET_BROWSER` environment variable is not set.');
			}

			if (!browserVendors.includes(targetBrowser)) {
				this.error(`Browser "${targetBrowser}" is not supported.`);
			}

			try {
				const sourceManifestPath = path.resolve(root, options.manifestPath);
				this.addWatchFile(sourceManifestPath);

				const manifestInput = await loadJsonFile(sourceManifestPath);
				const transformed = transformer(manifestInput, targetBrowser, mode);

				if (options.usePackageJSONVersion) {
					try {
						const packageJsonPath = await findUpPackageJson(root);

						if (!packageJsonPath) {
							throw new Error("Couldn't find a closest package.json");
						}

						this.addWatchFile(packageJsonPath);

						const packageJson = await loadJsonFile(packageJsonPath);

						if (packageJson.version) {
							transformed.version = packageJson.version.replace(
								'-beta.',
								'.'
							);
						}
					} catch (err) {
						this.error(
							`Failed to process package.json: ${err.message}`
						);
					}
				}

				this.emitFile({
					type: 'asset',
					fileName: 'manifest.json',
					source: JSON.stringify(transformed, null, 2),
				});
			} catch (err) {
				this.error(`Failed to process manifest.json: ${err.message}`);
			}
		},
	};
}
