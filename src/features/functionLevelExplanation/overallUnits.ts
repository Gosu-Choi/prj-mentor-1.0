import * as fs from 'fs/promises';
import * as path from 'path';
import * as ts from 'typescript';
import { ChangeUnit, LineRange } from './models';
import { detectLanguageFromPath } from '../ast/language';
import { TreeSitterAnalyzer } from '../ast/treeSitterAnalyzer';

export interface OverallIndex {
	units: ChangeUnit[];
	unitsByFile: Map<string, ChangeUnit[]>;
}

export async function buildOverallIndex(
	workspaceRoot: string,
	filePaths: string[]
): Promise<OverallIndex> {
	const analyzer = new TreeSitterAnalyzer();
	const units: ChangeUnit[] = [];
	const unitsByFile = new Map<string, ChangeUnit[]>();

	for (const filePath of filePaths) {
		const language = detectLanguageFromPath(filePath);
		if (!language) {
			continue;
		}
		const absolutePath = path.isAbsolute(filePath)
			? filePath
			: path.join(workspaceRoot, filePath);
		let text = '';
		try {
			text = await fs.readFile(absolutePath, 'utf8');
		} catch {
			continue;
		}

		const analysis = await analyzer.analyzeFile(filePath, text);
		let createdUnits: ChangeUnit[] = [];
		if (analysis) {
			createdUnits = analysis.functions.map(def => {
				const containerName =
					def.kind === 'method' ? extractContainerName(def.qualifiedName) : undefined;
				return {
					filePath: normalizePath(workspaceRoot, filePath),
					range: { ...def.range },
					diffText: '',
					symbolName: def.name,
					definitionName: def.name,
					definitionType: def.kind,
					isOverall: true,
					elementKind: def.kind,
					qualifiedName: def.qualifiedName,
					containerName,
				};
			});
			for (const unit of createdUnits) {
				units.push(unit);
				appendUnit(unitsByFile, unit);
			}
		}

		const globals = collectGlobalVariables(language, filePath, text);
		for (const global of globals) {
			const unit: ChangeUnit = {
				filePath: normalizePath(workspaceRoot, filePath),
				range: { ...global.range },
				diffText: '',
				symbolName: global.name,
				definitionName: global.name,
				definitionType: 'variable',
				isOverall: true,
				elementKind: 'global',
				qualifiedName: global.name,
			};
			units.push(unit);
			appendUnit(unitsByFile, unit);
		}

		if (analysis && createdUnits.length > 0) {
			attachRelatedCalls(createdUnits, analysis.calls);
		}
	}

	sortIndex(units, unitsByFile);
	return { units, unitsByFile };
}

export function applyChangesToOverall(
	index: OverallIndex,
	changeUnits: ChangeUnit[]
): ChangeUnit[] {
	for (const unit of changeUnits) {
		const fileUnits = index.unitsByFile.get(unit.filePath);
		if (!fileUnits) {
			continue;
		}
		if (unit.changeKind === 'operation') {
			const target = findEnclosingUnit(fileUnits, unit.range.startLine);
			if (target) {
				markOperation(target);
				mergeDiff(target, unit);
				continue;
			}
		}

		if (unit.changeKind === 'definition' || unit.changeKind === 'global') {
			const target =
				findByDefinitionName(fileUnits, unit) ??
				findEnclosingUnit(fileUnits, unit.range.startLine);
			if (target) {
				markKind(target, unit.changeKind);
				mergeDiff(target, unit);
				continue;
			}
			const clone: ChangeUnit = {
				...unit,
				isOverall: true,
				symbolName: unit.definitionName ?? unit.symbolName,
				elementKind: resolveElementKind(unit),
				qualifiedName: unit.qualifiedName,
				containerName: unit.containerName,
			};
			index.units.push(clone);
			appendUnit(index.unitsByFile, clone);
		}
	}

	sortIndex(index.units, index.unitsByFile);
	return index.units;
}

function collectGlobalVariables(
	language: 'javascript' | 'typescript' | 'python',
	filePath: string,
	text: string
): Array<{ name: string; range: LineRange }> {
	if (language === 'python') {
		return collectPythonGlobals(text);
	}
	const sourceFile = ts.createSourceFile(
		filePath,
		text,
		ts.ScriptTarget.Latest,
		true
	);
	return collectTsGlobals(sourceFile);
}

function collectTsGlobals(
	sourceFile: ts.SourceFile
): Array<{ name: string; range: LineRange }> {
	const globals: Array<{ name: string; range: LineRange }> = [];

	for (const statement of sourceFile.statements) {
		if (!ts.isVariableStatement(statement)) {
			continue;
		}
		for (const decl of statement.declarationList.declarations) {
			if (!ts.isIdentifier(decl.name)) {
				continue;
			}
			const start = decl.getStart(sourceFile, false);
			const end = decl.initializer?.end ?? decl.end;
			const startLine =
				ts.getLineAndCharacterOfPosition(sourceFile, start).line + 1;
			const endLine =
				ts.getLineAndCharacterOfPosition(sourceFile, end).line + 1;
			globals.push({
				name: decl.name.text,
				range: { startLine, endLine },
			});
		}
	}

	return globals;
}

function attachRelatedCalls(
	units: ChangeUnit[],
	calls: Array<{ name: string; qualifiedName?: string; range: LineRange }>
): void {
	for (const unit of units) {
		const related = calls.filter(call =>
			rangesOverlap(call.range, unit.range)
		);
		if (related.length > 0) {
			unit.relatedCalls = related.map(call => ({
				name: call.name,
				qualifiedName: call.qualifiedName,
				range: { ...call.range },
			}));
		}
	}
}

function collectPythonGlobals(
	text: string
): Array<{ name: string; range: LineRange }> {
	const globals: Array<{ name: string; range: LineRange }> = [];
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i] ?? '';
		if (!line || /^\s+/.test(line)) {
			continue;
		}
		if (/^(def|class|from|import)\s+/.test(line)) {
			continue;
		}
		const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line.trim());
		if (!match) {
			continue;
		}
		globals.push({
			name: match[1],
			range: { startLine: i + 1, endLine: i + 1 },
		});
	}
	return globals;
}

function appendUnit(
	unitsByFile: Map<string, ChangeUnit[]>,
	unit: ChangeUnit
): void {
	const list = unitsByFile.get(unit.filePath) ?? [];
	list.push(unit);
	unitsByFile.set(unit.filePath, list);
}

function sortIndex(
	units: ChangeUnit[],
	unitsByFile: Map<string, ChangeUnit[]>
): void {
	units.sort(compareUnits);
	for (const list of unitsByFile.values()) {
		list.sort(compareUnits);
	}
}

function compareUnits(a: ChangeUnit, b: ChangeUnit): number {
	if (a.filePath !== b.filePath) {
		return a.filePath.localeCompare(b.filePath);
	}
	if (a.range.startLine !== b.range.startLine) {
		return a.range.startLine - b.range.startLine;
	}
	return a.range.endLine - b.range.endLine;
}

function normalizePath(
	workspaceRoot: string,
	filePath: string
): string {
	const absolute = path.isAbsolute(filePath)
		? filePath
		: path.join(workspaceRoot, filePath);
	return path
		.relative(workspaceRoot, absolute)
		.replace(/\\/g, '/');
}

function extractContainerName(qualifiedName: string): string | undefined {
	const parts = qualifiedName.split('.');
	if (parts.length < 2) {
		return undefined;
	}
	return parts[parts.length - 2] || undefined;
}

function findEnclosingUnit(
	units: ChangeUnit[],
	line: number
): ChangeUnit | undefined {
	const candidates = units.filter(unit =>
		unit.range.startLine <= line && unit.range.endLine >= line
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

function findByDefinitionName(
	units: ChangeUnit[],
	unit: ChangeUnit
): ChangeUnit | undefined {
	if (!unit.definitionName) {
		return undefined;
	}
	const candidates = units.filter(candidate =>
		candidate.definitionName === unit.definitionName &&
		rangesOverlap(candidate.range, unit.range)
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

function rangesOverlap(a: LineRange, b: LineRange): boolean {
	return a.startLine <= b.endLine && b.startLine <= a.endLine;
}

function markOperation(unit: ChangeUnit): void {
	unit.changeKind = 'operation';
}

function markKind(
	unit: ChangeUnit,
	kind: 'definition' | 'global'
): void {
	if (kind === 'global') {
		unit.elementKind = 'global';
	} else if (!unit.elementKind) {
		unit.elementKind = 'function';
	}
	if (unit.changeKind !== 'operation') {
		unit.changeKind = kind;
	}
}

function mergeDiff(target: ChangeUnit, source: ChangeUnit): void {
	if (source.introducedDefinitions?.length) {
		target.introducedDefinitions = [
			...(target.introducedDefinitions ?? []),
			...source.introducedDefinitions,
		];
	}
	if (source.diffText) {
		target.diffText = target.diffText
			? `${target.diffText}\n${source.diffText}`
			: source.diffText;
	}
	if (source.definitionName && !target.definitionName) {
		target.definitionName = source.definitionName;
	}
	if (source.definitionType && !target.definitionType) {
		target.definitionType = source.definitionType;
	}
	if (source.symbolName && !target.symbolName) {
		target.symbolName = source.symbolName;
	}
	if (source.elementKind && !target.elementKind) {
		target.elementKind = source.elementKind;
	}
}

function resolveElementKind(unit: ChangeUnit): ChangeUnit['elementKind'] {
	if (unit.changeKind === 'global') {
		return 'global';
	}
	if (unit.definitionType === 'class') {
		return 'class';
	}
	if (unit.definitionType === 'method') {
		return 'method';
	}
	if (unit.definitionType === 'function') {
		return 'function';
	}
	if (unit.definitionType === 'variable') {
		return 'global';
	}
	return unit.elementKind;
}
