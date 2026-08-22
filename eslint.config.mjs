import nodeConfig from './config/eslint/node.js';
import tsConfig from './config/eslint/typescript.js';
import reactConfig from './config/eslint/react.js';

export default [
	{
		ignores: [
			'node_modules/**',
			'extension/**',
			'config/**',
			'*.js',
			'*.mjs',
			'vite.config.ts',
		],
	},
	...nodeConfig({
		files: ['**/*.ts', '**/*.tsx'],
	}),
	...tsConfig({
		files: ['**/*.ts', '**/*.tsx'],
	}),
	...reactConfig({
		files: ['**/*.tsx'],
	}),
	{
		files: ['**/*.ts', '**/*.tsx'],
		rules: {
			'no-console': 'off',
			'@typescript-eslint/no-use-before-define': 'warn',
			'@typescript-eslint/no-explicit-any': 'warn',
			'curly': ['error', 'all'],
			'import-x/no-duplicates': 'off',
		},
	},
	// Migrated from coolhusky-main (Vue) — keep original coding style for 1:1 parity
	{
		files: ['source/scripts/background/**', 'source/scripts/content/**', 'source/utils/*.ts'],
		rules: {
			'@typescript-eslint/explicit-function-return-type': 'off',
			'@typescript-eslint/no-explicit-any': 'warn',
			'n/no-unsupported-features/node-builtins': 'off',
			'@typescript-eslint/consistent-type-imports': 'off',
			'@typescript-eslint/no-empty-function': 'off',
			'no-empty': 'off',
			'func-names': 'off',
		},
	},
	// Browser UI pages (popup/sidepanel/welcome) run in the browser, not Node
	{
		files: ['source/pages/popup/**', 'source/pages/sidepanel/**', 'source/pages/welcome/**'],
		rules: {
			'n/no-unsupported-features/node-builtins': 'off',
		},
	},
	{
		files: ['**/*.tsx'],
		rules: {
			'react/jsx-props-no-spreading': 'off',
			'react/react-in-jsx-scope': 'off',
			'jsx-a11y/label-has-associated-control': 'off',
			'jsx-a11y/media-has-caption': 'off',
		},
	},
];
