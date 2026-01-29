import * as path from 'path';
import * as fs from 'fs/promises';
import * as ts from 'typescript';
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
		FileAnalysis
	>();
	const fileTextCache = new Map<string, string>();

	for (const unit of units) {
		const language = detectLanguageFromPath(unit.filePath);
		const analysis = await getDefinitionsForFile(
			unit.filePath,
			workspaceRoot,
			language,
			analyzer,
			analysisCache,
			fileTextCache
		);
		let sourceText = analysis?.sourceText;
		if (!sourceText && language) {
			const absolute = path.isAbsolute(unit.filePath)
				? unit.filePath
				: path.join(workspaceRoot, unit.filePath);
			try {
				sourceText = await readFileCached(absolute, fileTextCache);
			} catch {
				sourceText = undefined;
			}
		}
		const addedLines = collectAddedLines(unit.diffText);
		const analysisDefinitions = analysis?.definitions ?? [];
		const definitions = language
			? findDefinitions(
					addedLines,
					language,
					analysisDefinitions,
					sourceText,
					analysis?.tsSourceFile
				)
			: [];
		const changeType = classifyChange(unit.diffText);

		const definitionHitRanges = definitions.map(def => def.range);
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
			const changeKind =
				def.type === 'global-variable'
					? 'global'
					: 'definition';
			const containerName =
				def.type === 'method' ? deriveContainerName(def.qualifiedName) : undefined;
			result.push({
				...unit,
				range: { ...def.range },
				diffText: defDiff,
				changeKind,
				changeType,
				definitionName: def.name,
				definitionType:
					def.type === 'global-variable' ? 'variable' : def.type,
				elementKind:
					def.type === 'global-variable'
						? 'global'
						: def.type === 'class'
							? 'class'
							: def.type === 'method'
								? 'method'
								: 'function',
				qualifiedName: def.qualifiedName,
				containerName,
			});
		}

		const operationalAddedLines = addedLines.filter(line =>
			!definitionLineNumbers.has(line.lineNumber) &&
			!definitionHitRanges.some(range =>
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
		if (definitions.length === 0 && operationalGroups.length === 0) {
			const enclosing = findEnclosingDefinition(
				language,
				analysisDefinitions,
				unit.range.startLine,
				sourceText
			);
			result.push({
				...unit,
				changeKind: 'operation',
				changeType,
				elementKind:
					unit.elementKind ??
					(enclosing ? mapDefinitionKind(enclosing.kind) as ChangeUnit['elementKind'] : undefined),
				symbolName:
					enclosing?.name ?? unit.symbolName,
				qualifiedName:
					enclosing?.qualifiedName ?? unit.qualifiedName,
				definitionName:
					enclosing?.name ?? unit.definitionName,
				definitionType:
					enclosing?.kind ? mapDefinitionKind(enclosing.kind) : unit.definitionType,
				segmentId: enclosing ? buildSegmentId(unit.filePath, enclosing) : unit.segmentId,
			});
			continue;
		}
		for (const group of operationalGroups) {
			const groupRange = {
				startLine: group[0],
				endLine: group[group.length - 1],
			};
			const byDefinition = splitLinesByDefinitions(
				group,
				definitions
			);
			if (byDefinition.length === 0) {
				const enclosing = findEnclosingDefinition(
					language,
					analysisDefinitions,
					groupRange.startLine,
					sourceText
				);
				const operationalDiff = filterDiffTextByAddedLineNumbers(
					unit.diffText,
					new Set(group),
					false
				);
				result.push({
					...unit,
					range: groupRange,
					diffText: operationalDiff,
					changeKind: 'operation',
					changeType,
					elementKind:
						unit.elementKind ??
						(enclosing ? mapDefinitionKind(enclosing.kind) as ChangeUnit['elementKind'] : undefined),
					symbolName:
						enclosing?.name ?? unit.symbolName,
					qualifiedName:
						enclosing?.qualifiedName ?? unit.qualifiedName,
					definitionName:
						enclosing?.name ?? unit.definitionName,
					definitionType:
						enclosing?.kind ? mapDefinitionKind(enclosing.kind) : unit.definitionType,
					segmentId: enclosing ? buildSegmentId(unit.filePath, enclosing) : unit.segmentId,
				});
				continue;
			}

			for (const chunk of byDefinition) {
				const enclosing = findEnclosingDefinition(
					language,
					analysisDefinitions,
					chunk.lineNumbers[0],
					sourceText
				);
				const operationalDiff = filterDiffTextByAddedLineNumbers(
					unit.diffText,
					new Set(chunk.lineNumbers),
					false
				);
				const chunkRange = {
					startLine: chunk.lineNumbers[0],
					endLine:
						chunk.lineNumbers[chunk.lineNumbers.length - 1],
				};
				result.push({
					...unit,
					range: chunkRange,
					diffText: operationalDiff,
					changeKind: 'operation',
					changeType,
					elementKind:
						unit.elementKind ??
						(enclosing ? mapDefinitionKind(enclosing.kind) as ChangeUnit['elementKind'] : undefined),
					symbolName:
						enclosing?.name ?? unit.symbolName,
					qualifiedName:
						enclosing?.qualifiedName ?? unit.qualifiedName,
					definitionName:
						enclosing?.name ?? unit.definitionName,
					definitionType:
						enclosing?.kind ? mapDefinitionKind(enclosing.kind) : unit.definitionType,
					segmentId: enclosing ? buildSegmentId(unit.filePath, enclosing) : unit.segmentId,
				});
			}
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
	qualifiedName?: string;
};

function findDefinitions(
	addedLines: AddedLine[],
	language: 'javascript' | 'typescript' | 'python',
	definitions: DefinitionRange[],
	sourceText: string | undefined,
	tsSourceFile: ts.SourceFile | undefined
): DefinitionHit[] {
	const results: DefinitionHit[] = [];
	const addedLineSet = new Set(addedLines.map(line => line.lineNumber));
	const addedLineText = new Map(
		addedLines.map(line => [line.lineNumber, line.text])
	);
	const existingKeys = new Set<string>();
	for (const line of addedLines) {
		const hit = detectDefinition(line.text, language);
		if (hit) {
			let isGlobal = false;
			if (hit.type === 'variable') {
				isGlobal = isGlobalVariable(
					language,
					definitions,
					sourceText,
					tsSourceFile,
					line.lineNumber
				);
				if (!isGlobal) {
					continue;
				}
			}
			const resolved = resolveDefinitionRange(
				definitions,
				hit.name,
				line.lineNumber,
				hit.type
			);
			let range = resolved.range;
			let type =
				hit.type === 'variable' && isGlobal
					? 'global-variable'
					: resolved.kind ?? hit.type;
			const qualifiedName = resolved.qualifiedName;

			if (type === 'global-variable') {
				const variableRange = resolveVariableRange(
					language,
					sourceText,
					tsSourceFile,
					line.lineNumber
				);
				if (variableRange) {
					range = variableRange;
				}
			}
			if (range.startLine !== line.lineNumber) {
				continue;
			}
			const key = `${hit.name}|${range.startLine}-${range.endLine}|${type}`;
			if (existingKeys.has(key)) {
				continue;
			}
			existingKeys.add(key);
			results.push({
				lineNumber: line.lineNumber,
				name: hit.name,
				type,
				range,
				qualifiedName,
			});
		}
	}

	for (const def of definitions) {
		if (!addedLineSet.has(def.range.startLine)) {
			continue;
		}
		const lineText = addedLineText.get(def.range.startLine) ?? '';
		if (!lineContainsIdentifier(lineText, def.name)) {
			continue;
		}
		const type = mapDefinitionKind(def.kind);
		const key = `${def.name}|${def.range.startLine}-${def.range.endLine}|${type}`;
		if (existingKeys.has(key)) {
			continue;
		}
		existingKeys.add(key);
		results.push({
			lineNumber: def.range.startLine,
			name: def.name,
			type,
			range: def.range,
			qualifiedName: def.qualifiedName,
		});
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
		if (/^(from|import)\s+/.test(text)) {
			return null;
		}
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

function splitLinesByDefinitions(
	lineNumbers: number[],
	definitions: DefinitionHit[]
): Array<{ definition?: DefinitionHit; lineNumbers: number[] }> {
	if (lineNumbers.length === 0) {
		return [];
	}
	const lineSet = new Set(lineNumbers);
	const buckets: Array<{
		definition?: DefinitionHit;
		lineNumbers: number[];
	}> = [];
	const usedLines = new Set<number>();

	for (const def of definitions) {
		const lines = lineNumbers.filter(
			line =>
				isWithinRange(def.range, line) &&
				lineSet.has(line)
		);
		if (lines.length === 0) {
			continue;
		}
		lines.forEach(line => usedLines.add(line));
		buckets.push({
			definition: def,
			lineNumbers: lines,
		});
	}

	const remaining = lineNumbers.filter(
		line => !usedLines.has(line)
	);
	if (remaining.length > 0) {
		buckets.push({ lineNumbers: remaining });
	}

	return buckets;
}

type DefinitionRange = {
	name: string;
	range: LineRange;
	kind?: 'function' | 'method' | 'class';
	qualifiedName?: string;
};

async function getDefinitionsForFile(
	filePath: string,
	workspaceRoot: string,
	language: 'javascript' | 'typescript' | 'python' | undefined,
	analyzer: TreeSitterAnalyzer,
	cache: Map<
		string,
		FileAnalysis
	>
	,
	textCache: Map<string, string>
): Promise<FileAnalysis | undefined> {
	const key = path.normalize(filePath);
	const cached = cache.get(key);
	if (cached) {
		return cached;
	}
	if (!language) {
		const empty: FileAnalysis = { language, definitions: [] };
		cache.set(key, empty);
		return empty;
	}
	const absolute = path.isAbsolute(filePath)
		? filePath
		: path.join(workspaceRoot, filePath);
	try {
		const text = await readFileCached(absolute, textCache);
		const analysis = await analyzer.analyzeFile(filePath, text);
		const definitions = analysis?.functions.map(def => ({
			name: def.name,
			range: def.range,
			kind: def.kind,
			qualifiedName: def.qualifiedName,
		})) ?? [];
		const tsSourceFile =
			language === 'javascript' || language === 'typescript'
				? ts.createSourceFile(
						absolute,
						text,
						ts.ScriptTarget.Latest,
						true
					)
				: undefined;
		const payload: FileAnalysis = {
			language,
			definitions,
			sourceText: text,
			tsSourceFile,
		};
		cache.set(key, payload);
		return payload;
	} catch {
		const empty: FileAnalysis = { language, definitions: [] };
		cache.set(key, empty);
		return empty;
	}
}

function resolveDefinitionRange(
	definitions: DefinitionRange[],
	name: string,
	lineNumber: number,
	expectedType?: string
): { range: LineRange; kind?: string; qualifiedName?: string; isGlobal?: boolean } {
	const expectedKind = expectedType
		? normalizeDefinitionKind(expectedType)
		: undefined;
	const containing = definitions.filter(def =>
		isWithinRange(def.range, lineNumber)
	);
	if (containing.length > 0) {
		const ranked = expectedKind
			? containing.filter(def => def.kind === expectedKind)
			: containing;
		const candidates = ranked.length > 0 ? ranked : containing;
		const best = candidates.reduce((prev, current) => {
			const prevSpan = prev.range.endLine - prev.range.startLine;
			const currSpan = current.range.endLine - current.range.startLine;
			return currSpan < prevSpan ? current : prev;
		});
		return {
			range: best.range,
			kind: best.kind,
			qualifiedName: best.qualifiedName,
		};
	}
	const named = definitions.filter(def => def.name === name);
	if (named.length > 0) {
		return {
			range: named[0].range,
			kind: named[0].kind,
			qualifiedName: named[0].qualifiedName,
		};
	}
	return { range: { startLine: lineNumber, endLine: lineNumber } };
}

function isWithinRange(range: LineRange, lineNumber: number): boolean {
	return range.startLine <= lineNumber && lineNumber <= range.endLine;
}

function rangesOverlap(a: LineRange, b: LineRange): boolean {
	return a.startLine <= b.endLine && b.startLine <= a.endLine;
}

function buildSegmentId(
	filePath: string,
	definition: DefinitionRange
): string {
	return `${filePath}|${definition.range.startLine}-${definition.range.endLine}`;
}

function deriveContainerName(qualifiedName: string | undefined): string | undefined {
	if (!qualifiedName) {
		return undefined;
	}
	const parts = qualifiedName.split('.');
	if (parts.length < 2) {
		return undefined;
	}
	return parts.slice(0, -1).join('.');
}

function findEnclosingDefinitionRange(
	definitions: DefinitionRange[],
	lineNumber: number
): DefinitionRange | undefined {
	const candidates = definitions.filter(def =>
		isWithinRange(def.range, lineNumber)
	);
	if (candidates.length === 0) {
		return undefined;
	}
	return candidates.reduce((best, current) => {
		const bestSpan = best.range.endLine - best.range.startLine;
		const currentSpan = current.range.endLine - current.range.startLine;
		return currentSpan < bestSpan ? current : best;
	});
}

function findEnclosingDefinition(
	language: 'javascript' | 'typescript' | 'python' | undefined,
	definitions: DefinitionRange[],
	lineNumber: number,
	sourceText: string | undefined
): DefinitionRange | undefined {
	const enclosing = findEnclosingDefinitionRange(definitions, lineNumber);
	if (enclosing) {
		return enclosing;
	}
	if (language === 'python' && sourceText) {
		return findPythonEnclosingDefinition(sourceText, lineNumber);
	}
	return undefined;
}

function findPythonEnclosingDefinition(
	sourceText: string,
	lineNumber: number
): DefinitionRange | undefined {
	const lines = sourceText.split(/\r?\n/);
	const startIndex = Math.min(lines.length - 1, Math.max(0, lineNumber - 1));
	for (let i = startIndex; i >= 0; i -= 1) {
		const raw = lines[i] ?? '';
		if (!raw.trim() || raw.trim().startsWith('#')) {
			continue;
		}
		const match = /^\s*(async\s+def|def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(raw);
		if (!match) {
			continue;
		}
		const kind = match[1] === 'class' ? 'class' : 'function';
		const indent = raw.match(/^\s*/)?.[0] ?? '';
		const indentLength = indent.length;
		let endLine = i + 1;
		for (let j = i + 1; j < lines.length; j += 1) {
			const next = lines[j] ?? '';
			if (!next.trim() || next.trim().startsWith('#')) {
				continue;
			}
			const nextIndent = next.match(/^\s*/)?.[0] ?? '';
			if (nextIndent.length <= indentLength) {
				endLine = j;
				break;
			}
			endLine = j + 1;
		}
		return {
			name: match[2],
			range: { startLine: i + 1, endLine },
			kind,
		};
	}
	return undefined;
}

type FileAnalysis = {
	language: 'javascript' | 'typescript' | 'python' | undefined;
	definitions: DefinitionRange[];
	sourceText?: string;
	tsSourceFile?: ts.SourceFile;
};

async function readFileCached(
	absolutePath: string,
	cache: Map<string, string>
): Promise<string> {
	const cached = cache.get(absolutePath);
	if (cached !== undefined) {
		return cached;
	}
	const text = await fs.readFile(absolutePath, 'utf8');
	cache.set(absolutePath, text);
	return text;
}

function isGlobalVariable(
	language: 'javascript' | 'typescript' | 'python',
	definitions: DefinitionRange[],
	sourceText: string | undefined,
	tsSourceFile: ts.SourceFile | undefined,
	lineNumber: number
): boolean {
	const inDefinition = definitions.some(def =>
		isWithinRange(def.range, lineNumber)
	);
	if (inDefinition) {
		return false;
	}
	if (language === 'python') {
		return true;
	}
	if (language === 'javascript' || language === 'typescript') {
		if (!tsSourceFile || !sourceText) {
			return true;
		}
		return isTopLevelVariableInTsAst(tsSourceFile, lineNumber);
	}
	return false;
}

function isTopLevelVariableInTsAst(
	sourceFile: ts.SourceFile,
	lineNumber: number
): boolean {
	const position = ts.getPositionOfLineAndCharacter(
		sourceFile,
		Math.max(0, lineNumber - 1),
		0
	);
	let isTopLevel = false;

	const visit = (node: ts.Node) => {
		if (position < node.pos || position > node.end) {
			return;
		}
		if (ts.isVariableDeclaration(node)) {
			let parent: ts.Node | undefined = node.parent;
			while (
				parent &&
				!ts.isSourceFile(parent) &&
				!ts.isFunctionLike(parent) &&
				!ts.isClassLike(parent)
			) {
				parent = parent.parent;
			}
			if (parent && ts.isSourceFile(parent)) {
				isTopLevel = true;
			}
		}
		ts.forEachChild(node, visit);
	};

	visit(sourceFile);
	return isTopLevel;
}

function resolveVariableRange(
	language: 'javascript' | 'typescript' | 'python',
	sourceText: string | undefined,
	tsSourceFile: ts.SourceFile | undefined,
	startLine: number
): LineRange | undefined {
	if (!sourceText) {
		return undefined;
	}
	if (language === 'python') {
		const lines = sourceText.split(/\r?\n/);
		const stringRange = scanPythonStringRange(lines, startLine);
		if (stringRange) {
			return stringRange;
		}
		return scanBracketRange(lines, startLine, 'python');
	}
	if (language === 'javascript' || language === 'typescript') {
		if (tsSourceFile) {
			const range = findVariableRangeInTsAst(tsSourceFile, startLine);
			if (range) {
				return range;
			}
		}
		const lines = sourceText.split(/\r?\n/);
		return scanBracketRange(lines, startLine, 'javascript');
	}
	return undefined;
}

function findVariableRangeInTsAst(
	sourceFile: ts.SourceFile,
	line: number
): LineRange | undefined {
	const position = ts.getPositionOfLineAndCharacter(
		sourceFile,
		Math.max(0, line - 1),
		0
	);
	let best:
		| { start: number; end: number }
		| undefined;

	const visit = (node: ts.Node) => {
		if (position < node.pos || position > node.end) {
			return;
		}
		if (ts.isVariableDeclaration(node)) {
			const start = node.getStart(sourceFile, false);
			const end = node.initializer?.end ?? node.end;
			const span = end - start;
			if (!best || span < best.end - best.start) {
				best = { start, end };
			}
		}
		ts.forEachChild(node, visit);
	};

	visit(sourceFile);
	if (!best) {
		return undefined;
	}
	const startLine = ts.getLineAndCharacterOfPosition(sourceFile, best.start).line + 1;
	const endLine = ts.getLineAndCharacterOfPosition(sourceFile, best.end).line + 1;
	return { startLine, endLine };
}

function scanBracketRange(
	lines: string[],
	startLine: number,
	language: 'python' | 'javascript'
): LineRange | undefined {
	const startIndex = Math.max(0, startLine - 1);
	let balance = 0;
	let endLine = startLine;
	for (let i = startIndex; i < lines.length; i += 1) {
		const raw = lines[i];
		const text = sanitizeForBracketScan(raw, language);
		for (const char of text) {
			switch (char) {
				case '{':
				case '[':
				case '(':
					balance += 1;
					break;
				case '}':
				case ']':
				case ')':
					balance -= 1;
					break;
				default:
					break;
			}
		}
		endLine = i + 1;
		const trimmed = raw.trim();
		const hasContinuation =
			language === 'python' ? trimmed.endsWith('\\') : false;
		if (balance <= 0 && !hasContinuation && i !== startIndex) {
			break;
		}
		if (balance <= 0 && i === startIndex) {
			break;
		}
	}
	return { startLine, endLine };
}

function scanPythonStringRange(
	lines: string[],
	startLine: number
): LineRange | undefined {
	const startIndex = Math.max(0, startLine - 1);
	const firstLine = lines[startIndex] ?? '';
	const triple = findTripleQuote(firstLine);
	if (!triple) {
		return undefined;
	}
	const sameLineClosing = hasClosingTriple(firstLine, triple, firstLine.indexOf(triple) + 3);
	if (sameLineClosing) {
		return { startLine, endLine: startLine };
	}
	for (let i = startIndex + 1; i < lines.length; i += 1) {
		if (hasClosingTriple(lines[i] ?? '', triple, 0)) {
			return { startLine, endLine: i + 1 };
		}
	}
	return { startLine, endLine: lines.length };
}

function findTripleQuote(line: string): `"""` | `'''` | undefined {
	const dbl = line.indexOf('"""');
	const sng = line.indexOf("'''");
	if (dbl < 0 && sng < 0) {
		return undefined;
	}
	if (dbl >= 0 && sng >= 0) {
		return dbl < sng ? '"""' : "'''";
	}
	return dbl >= 0 ? '"""' : "'''";
}

function hasClosingTriple(
	line: string,
	triple: `"""` | `'''`,
	fromIndex: number
): boolean {
	return line.indexOf(triple, fromIndex) >= 0;
}

function sanitizeForBracketScan(
	line: string,
	language: 'python' | 'javascript'
): string {
	let text = line;
	if (language === 'python') {
		const hash = text.indexOf('#');
		if (hash >= 0) {
			text = text.slice(0, hash);
		}
	}
	text = text.replace(/(["'])(?:\\.|(?!\1).)*\1/g, '');
	return text;
}

function mapDefinitionKind(kind: DefinitionRange['kind']): string {
	switch (kind) {
		case 'class':
			return 'class';
		case 'method':
			return 'method';
		case 'function':
		default:
			return 'function';
	}
}

function normalizeDefinitionKind(
	type: string
): DefinitionRange['kind'] | undefined {
	switch (type) {
		case 'class':
			return 'class';
		case 'method':
			return 'method';
		case 'function':
			return 'function';
		default:
			return undefined;
	}
}

function lineContainsIdentifier(
	text: string,
	identifier: string
): boolean {
	if (!text || !identifier) {
		return false;
	}
	const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const pattern = new RegExp(`\\b${escaped}\\b`);
	return pattern.test(text);
}

type ChangeType = 'add' | 'remove' | 'modify' | 'unknown';

function classifyChange(diffText: string): ChangeType {
	let hasAdd = false;
	let hasRemove = false;
	for (const line of diffText.split(/\r?\n/)) {
		if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) {
			continue;
		}
		if (line.startsWith('+')) {
			hasAdd = true;
		} else if (line.startsWith('-')) {
			hasRemove = true;
		}
	}
	if (hasAdd && hasRemove) {
		return 'modify';
	}
	if (hasAdd) {
		return 'add';
	}
	if (hasRemove) {
		return 'remove';
	}
	return 'unknown';
}
