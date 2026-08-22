// ============================================================================
// vite-plugin-app-meta
// ----------------------------------------------------------------------------
// Injects brand metadata from config/meta.ts into the build output:
//   1. Reads templates from source/locales/<lang>/messages.json (brand keys
//      removed, brand references in long copy replaced by {{META_*}} tokens),
//      injects extName/title/extDescription/welcomeSubtitle, replaces tokens,
//      then writes to _locales/<lang>/
//   2. Overrides manifest.json homepage_url / author / gecko.id
// Thus all user-visible branding is maintained in one place: config/meta.ts.
// ============================================================================
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let metaPromise = null;

/** Loads config/meta.ts (transpiled via esbuild and imported through a data URL to avoid extra runtime deps) */
function loadMeta() {
  if (!metaPromise) {
    metaPromise = (async () => {
      const metaPath = path.resolve(__dirname, 'meta.ts');
      const source = readFileSync(metaPath, 'utf-8');
      const { code } = await transform(source, { loader: 'ts', format: 'esm' });
      const mod = await import(
        `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
      );
      return mod.META;
    })();
  }
  return metaPromise;
}

/** Resolves the meta value for a language, falling back to en */
function langOf(meta, lang) {
  const out = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = value[lang] ?? value.en ?? value;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Replaces {{META_*}} tokens in a message */
function replaceTokens(message, langMeta) {
  return message
    .replaceAll('{{META_REF}}', langMeta.ref ?? '')
    .replaceAll('{{META_NAME}}', langMeta.name ?? '')
    .replaceAll('{{META_FULL_NAME}}', langMeta.fullName ?? '')
    .replaceAll('{{META_DESC}}', langMeta.description ?? '')
    .replaceAll('{{META_SLOGAN}}', langMeta.slogan ?? '');
}

/** Injected brand message keys -> meta fields */
const BRAND_KEYS = [
  ['extName', 'fullName'],
  ['title', 'name'],
  ['extDescription', 'description'],
  ['welcomeSubtitle', 'slogan'],
];

export function vitePluginAppMeta({ sourcePath, outDir }) {
  return {
    name: 'vite-plugin-app-meta',
    apply: 'build',
    async closeBundle() {
      const meta = await loadMeta();
      const templateDir = path.resolve(sourcePath, 'locales');

      if (existsSync(templateDir)) {
        for (const lang of readdirSync(templateDir)) {
          const templateFile = path.join(templateDir, lang, 'messages.json');
          if (!existsSync(templateFile)) continue;

          const data = JSON.parse(readFileSync(templateFile, 'utf-8'));
          const langMeta = langOf(meta, lang);

          // inject brand keys
          for (const [key, field] of BRAND_KEYS) {
            data[key] = { message: langMeta[field] };
          }

          // replace tokens in long-form copy
          for (const [key, entry] of Object.entries(data)) {
            if (entry && typeof entry.message === 'string') {
              data[key] = { ...entry, message: replaceTokens(entry.message, langMeta) };
            }
          }

          const outFile = path.resolve(outDir, '_locales', lang, 'messages.json');
          mkdirSync(path.dirname(outFile), { recursive: true });
          writeFileSync(outFile, JSON.stringify(data, null, 4) + '\n');
        }
      }

      // override manifest brand fields
      const manifestFile = path.resolve(outDir, 'manifest.json');
      if (existsSync(manifestFile)) {
        const manifest = JSON.parse(readFileSync(manifestFile, 'utf-8'));
        if (meta.homepageUrl) manifest.homepage_url = meta.homepageUrl;
        if (meta.author) manifest.author = meta.author;
        if (meta.firefoxId) {
          manifest.browser_specific_settings ??= {};
          manifest.browser_specific_settings.gecko ??= {};
          manifest.browser_specific_settings.gecko.id = meta.firefoxId;
        }
        writeFileSync(manifestFile, JSON.stringify(manifest, null, 4) + '\n');
      }
    },
  };
}
