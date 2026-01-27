import * as path from 'path';
import * as fs from 'fs/promises';
import { ChangeUnit, LineRange } from './models';
import { detectLanguageFromPath } from '../ast/language';
import { TreeSitterAnalyzer } from '../ast/treeSitterAnalyzer';

const HUNK_HEADER = /@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseChangeUnitsFromDiff(
	diffText: string,
	workspaceRoot: string
): ChangeUnit[] {
	const lines = diffText.split(/\r?\n/);
	const units: ChangeUnit[] = [];

	let currentFile: string | null = null;
	let currentHunkLines: string[] = [];
	let currentHunkHeader: {
		newStart: number;
		newLength: number;
	} | null = null;

	const flushHunk = () => {
		if (!currentFile || !currentHunkHeader) {
			currentHunkLines = [];
			currentHunkHeader = null;
			return;
		}

		const { newStart, newLength } = currentHunkHeader;
		const startLine = Math.max(1, newStart);
		const endLine =
			newLength > 0 ? startLine + newLength - 1 : startLine;

		units.push({
			filePath: currentFile,
			range: { startLine, endLine },
			diffText: currentHunkLines.join('\n'),
		});

		currentHunkLines = [];
		currentHunkHeader = null;
	};

	for (const line of lines) {
		if (line.startsWith('diff --git ')) {
			flushHunk();
			currentFile = null;
			continue;
		}

		if (line.startsWith('+++ ')) {
			const filePath = line.replace('+++ ', '').trim();
			if (filePath === '/dev/null') {
				currentFile = null;
				continue;
			}
			if (filePath.startsWith('b/')) {
				currentFile = path
					.normalize(filePath.slice(2))
					.replace(/\\/g, '/');
			} else {
				currentFile = path.normalize(filePath).replace(/\\/g, '/');
			}
			continue;
		}

		const hunkMatch = HUNK_HEADER.exec(line);
		if (hunkMatch) {
			flushHunk();
			const newStart = Number.parseInt(hunkMatch[3], 10);
			const newLength = Number.parseInt(hunkMatch[4] ?? '1', 10);
			currentHunkHeader = { newStart, newLength };
			currentHunkLines.push(line);
			continue;
		}

		if (currentHunkHeader) {
			currentHunkLines.push(line);
		}
	}

	flushHunk();

	return units.filter(unit => {
		const inWorkspace = path.isAbsolute(unit.filePath)
			? unit.filePath.startsWith(workspaceRoot)
			: true;
		const isMarkdown = unit.filePath.toLowerCase().endsWith('.md');
		return inWorkspace && !isMarkdown;
	});
}

export async function splitChangeUnitsByDefinitions(
	units: ChangeUnit[],
	workspaceRoot: string
): Promise<ChangeUnit[]> {
	const result: ChangeUnit[] = [];
	const analyzer = new TreeSitterAnalyzer();
	const analysisCache = new Map<
		string,
		{ language: 'javascript' | 'typescript' | 'python' | undefined; definitions: DefinitionRange[] }
	>();

	for (const unit of units) {
		const language = detectLanguageFromPath(unit.filePath);
		const analysis = await getDefinitionsForFile(
			unit.filePath,
			workspaceRoot,
			language,
			analyzer,
			analysisCache
		);
		const addedLines = collectAddedLines(unit.diffText);
		const definitions = language
			? findDefinitions(addedLines, language, analysis?.definitions ?? [])
			: [];

		if (definitions.length === 0) {
			unit.changeKind = 'operation';
			result.push(unit);
			continue;
		}

		const definitionRanges = definitions.map(def => def.range);
		const definitionLineNumbers = new Set(
			definitions.map(def => def.lineNumber)
		);
		for (const def of definitions) {
			const defDiff = filterDiffTextByAddedLineNumbers(
				unit.diffText,
				new Set(
					addedLines
						.filter(line => isWithinRange(def.range, line.lineNumber))
						.map(line => line.lineNumber)
				),
				true
			);
			result.push({
				...unit,
				range: { ...def.range },
				diffText: defDiff,
				changeKind: 'definition',
				definitionName: def.name,
				definitionType: def.type,
			});
		}

		const operationalAddedLines = addedLines.filter(line =>
			!definitionLineNumbers.has(line.lineNumber) &&
			!definitionRanges.some(range =>
				isWithinRange(range, line.lineNumber)
			) &&
			isMeaningfulAddedLine(line.text, language)
		);
		const operationalLineNumbers = operationalAddedLines
			.map(line => line.lineNumber)
			.sort((a, b) => a - b);
		const operationalGroups = groupContiguousLines(
			operationalLineNumbers
		);
		for (const group of operationalGroups) {
			const operationalDiff = filterDiffTextByAddedLineNumbers(
				unit.diffText,
				new Set(group),
				false
			);
			result.push({
				...unit,
				range: {
					startLine: group[0],
					endLine: group[group.length - 1],
				},
				diffText: operationalDiff,
				changeKind: 'operation',
				introducedDefinitions: definitions.map(def => ({
					name: def.name,
					type: def.type,
					range: { ...def.range },
				})),
			});
		}
	}

	return result;
}

type AddedLine = {
	lineNumber: number;
	text: string;
};

function collectAddedLines(diffText: string): AddedLine[] {
	const lines = diffText.split(/\r?\n/);
	const added: AddedLine[] = [];
	let newLine = 0;

	for (const line of lines) {
		const hunkMatch = HUNK_HEADER.exec(line);
		if (hunkMatch) {
			newLine = Number.parseInt(hunkMatch[3], 10);
			continue;
		}

		if (line.startsWith('+++') || line.startsWith('---')) {
			continue;
		}

		if (line.startsWith(' ')) {
			newLine += 1;
			continue;
		}

		if (line.startsWith('+')) {
			const text = line.slice(1);
			added.push({ lineNumber: newLine, text });
			newLine += 1;
			continue;
		}

		if (line.startsWith('-')) {
			continue;
		}

	}

	return added;
}

function filterDiffTextByAddedLineNumbers(
	diffText: string,
	lineNumbers: Set<number>,
	includeRemoved: boolean
): string {
	const lines = diffText.split(/\r?\n/);
	const filtered: string[] = [];
	let newLine = 0;

	for (const line of lines) {
		const hunkMatch = HUNK_HEADER.exec(line);
		if (hunkMatch) {
			newLine = Number.parseInt(hunkMatch[3], 10);
			filtered.push(line);
			continue;
		}

		if (line.startsWith('+++') || line.startsWith('---')) {
			filtered.push(line);
			continue;
		}

		if (line.startsWith(' ')) {
			newLine += 1;
			continue;
		}

		if (line.startsWith('+')) {
			if (lineNumbers.has(newLine)) {
				filtered.push(line);
			}
			newLine += 1;
			continue;
		}

		if (line.startsWith('-')) {
			if (includeRemoved) {
				filtered.push(line);
			}
			continue;
		}

	}

	return filtered.join('\n');
}

type DefinitionHit = {
	lineNumber: number;
	name: string;
	type: string;
	range: LineRange;
};

function findDefinitions(
	addedLines: AddedLine[],
	language: 'javascript' | 'typescript' | 'python',
	definitions: DefinitionRange[]
): DefinitionHit[] {
	const results: DefinitionHit[] = [];
	for (const line of addedLines) {
		const hit = detectDefinition(line.text, language);
		if (hit) {
			const range = resolveDefinitionRange(
				definitions,
				hit.name,
				line.lineNumber
			);
			if (range.startLine !== line.lineNumber) {
				continue;
			}
			results.push({
				lineNumber: line.lineNumber,
				name: hit.name,
				type: hit.type,
				range,
			});
		}
	}
	return results;
}

function detectDefinition(
	line: string,
	language: 'javascript' | 'typescript' | 'python'
): { name: string; type: string } | null {
	const text = line.trim();
	if (!text) {
		return null;
	}

	if (language === 'python') {
		const asyncDef = /^async\s+def\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(text);
		if (asyncDef) {
			return { name: asyncDef[1], type: 'function' };
		}
		const def = /^def\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(text);
		if (def) {
			return { name: def[1], type: 'function' };
		}
		const klass = /^class\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(text);
		if (klass) {
			return { name: klass[1], type: 'class' };
		}
		const assignment = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(text);
		if (assignment) {
			return { name: assignment[1], type: 'variable' };
		}
		return null;
	}

	const func = /^(export\s+)?(async\s+)?function\s+([A-Za-z0-9_$]+)/.exec(
		text
	);
	if (func) {
		return { name: func[3], type: 'function' };
	}
	const klass = /^(export\s+)?class\s+([A-Za-z0-9_$]+)/.exec(text);
	if (klass) {
		return { name: klass[2], type: 'class' };
	}
	const iface = /^(export\s+)?interface\s+([A-Za-z0-9_$]+)/.exec(text);
	if (iface) {
		return { name: iface[2], type: 'interface' };
	}
	const typeAlias = /^(export\s+)?type\s+([A-Za-z0-9_$]+)/.exec(text);
	if (typeAlias) {
		return { name: typeAlias[2], type: 'type' };
	}
	const enumDecl = /^(export\s+)?enum\s+([A-Za-z0-9_$]+)/.exec(text);
	if (enumDecl) {
		return { name: enumDecl[2], type: 'enum' };
	}
	const varDecl = /^(export\s+)?(const|let|var)\s+([A-Za-z0-9_$]+)/.exec(
		text
	);
	if (varDecl) {
		const name = varDecl[3];
		if (/\b=>\b/.test(text) || /\bfunction\b/.test(text)) {
			return { name, type: 'function' };
		}
		return { name, type: 'variable' };
	}
	return null;
}

function isMeaningfulAddedLine(
	text: string,
	language: 'javascript' | 'typescript' | 'python' | undefined
): boolean {
	const trimmed = text.trim();
	if (!trimmed) {
		return false;
	}
	if (language === 'python') {
		return !trimmed.startsWith('#');
	}
	if (language === 'javascript' || language === 'typescript') {
		if (trimmed.startsWith('//')) {
			return false;
		}
		if (trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('*/')) {
			return false;
		}
	}
	return true;
}

function groupContiguousLines(numbers: number[]): number[][] {
	if (numbers.length === 0) {
		return [];
	}
	const groups: number[][] = [];
	let current: number[] = [numbers[0]];
	for (let i = 1; i < numbers.length; i += 1) {
		const value = numbers[i];
		const prev = numbers[i - 1];
		if (value === prev + 1) {
			current.push(value);
			continue;
		}
		groups.push(current);
		current = [value];
	}
	groups.push(current);
	return groups;
}

type DefinitionRange = {
	name: string;
	range: LineRange;
};

async function getDefinitionsForFile(
	filePath: string,
	workspaceRoot: string,
	language: 'javascript' | 'typescript' | 'python' | undefined,
	analyzer: TreeSitterAnalyzer,
	cache: Map<
		string,
		{ language: 'javascript' | 'typescript' | 'python' | undefined; definitions: DefinitionRange[] }
	>
): Promise<{ language: typeof language; definitions: DefinitionRange[] } | undefined> {
	const key = path.normalize(filePath);
	const cached = cache.get(key);
	if (cached) {
		return cached;
	}
	if (!language) {
		const empty = { language, definitions: [] };
		cache.set(key, empty);
		return empty;
	}
	const absolute = path.isAbsolute(filePath)
		? filePath
		: path.join(workspaceRoot, filePath);
	try {
		const text = await fs.readFile(absolute, 'utf8');
		const analysis = await analyzer.analyzeFile(filePath, text);
		const definitions = analysis?.functions.map(def => ({
			name: def.name,
			range: def.range,
		})) ?? [];
		const payload = { language, definitions };
		cache.set(key, payload);
		return payload;
	} catch {
		const empty = { language, definitions: [] };
		cache.set(key, empty);
		return empty;
	}
}

function resolveDefinitionRange(
	definitions: DefinitionRange[],
	name: string,
	lineNumber: number
): LineRange {
	const containing = definitions.filter(def =>
		isWithinRange(def.range, lineNumber)
	);
	if (containing.length > 0) {
		const best = containing.reduce((prev, current) => {
			const prevSpan = prev.range.endLine - prev.range.startLine;
			const currSpan = current.range.endLine - current.range.startLine;
			return currSpan < prevSpan ? current : prev;
		});
		return best.range;
	}
	const named = definitions.filter(def => def.name === name);
	if (named.length > 0) {
		return named[0].range;
	}
	return { startLine: lineNumber, endLine: lineNumber };
}

function isWithinRange(range: LineRange, lineNumber: number): boolean {
	return range.startLine <= lineNumber && lineNumber <= range.endLine;
}
