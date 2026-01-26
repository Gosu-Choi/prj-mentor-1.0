import * as path from 'path';

export type SupportedLanguage =
	| 'javascript'
	| 'typescript'
	| 'python';

const JS_EXTENSIONS = new Set([
	'.js',
	'.cjs',
	'.mjs',
	'.jsx',
]);

const TS_EXTENSIONS = new Set(['.ts', '.tsx']);

const PY_EXTENSIONS = new Set(['.py']);

export function detectLanguageFromPath(
	filePath: string
): SupportedLanguage | undefined {
	const ext = path.extname(filePath).toLowerCase();
	if (JS_EXTENSIONS.has(ext)) {
		return 'javascript';
	}
	if (TS_EXTENSIONS.has(ext)) {
		return 'typescript';
	}
	if (PY_EXTENSIONS.has(ext)) {
		return 'python';
	}
	return undefined;
}
