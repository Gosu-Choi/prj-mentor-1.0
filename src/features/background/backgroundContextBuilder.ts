import * as fs from 'fs/promises';
import * as path from 'path';
import { TreeSitterAnalyzer } from '../ast/treeSitterAnalyzer';
import {
	ChangeUnit,
	CodeRegion,
	LineRange,
} from '../functionLevelExplanation/models';
import { getFileContentAtHead } from '../functionLevelExplanation/gitShow';

interface DefinitionLike {
	name: string;
	qualifiedName: string;
	range: LineRange;
	kind?: 'function' | 'method' | 'class';
}

export class BackgroundContextBuilder {
	private readonly analyzer = new TreeSitterAnalyzer();

	constructor(private readonly workspaceRoot: string) {}

	async attachBackgroundRegions(units: ChangeUnit[]): Promise<void> {
		const unitsByFile = new Map<string, ChangeUnit[]>();

		for (const unit of units) {
			const fileKey = normalizeRelativePath(
				this.workspaceRoot,
				unit.filePath
			);
			const list = unitsByFile.get(fileKey) ?? [];
			list.push(unit);
			unitsByFile.set(fileKey, list);
		}

	for (const [relativePath, fileUnits] of unitsByFile) {
			let headText: string;
			let revisedText: string;
			try {
				headText = await getFileContentAtHead(
					this.workspaceRoot,
					relativePath
				);
				revisedText = await fs.readFile(
					path.join(this.workspaceRoot, relativePath),
					'utf8'
				);
			} catch {
				continue;
			}
			if (!headText || !revisedText) {
				continue;
			}
			const headAnalysis = await this.analyzer.analyzeFile(
				relativePath,
				headText
			);
			const revisedAnalysis = await this.analyzer.analyzeFile(
				relativePath,
				revisedText
			);
			if (!headAnalysis || !revisedAnalysis) {
				continue;
			}
			for (const unit of fileUnits) {
				const { backgrounds, relatedCalls } =
					this.buildBackgroundRegionsForUnit(
					unit,
					relativePath,
					headAnalysis.functions,
					revisedAnalysis.calls,
					headAnalysis.functionsByName,
					headAnalysis.functionsByQualifiedName
				);
				if (backgrounds.length > 0) {
					unit.backgroundRegions = backgrounds;
				}
				if (relatedCalls.length > 0) {
					unit.relatedCalls = relatedCalls;
				}
			}
		}
	}

	private buildBackgroundRegionsForUnit(
		unit: ChangeUnit,
		relativePath: string,
		functions: DefinitionLike[],
		calls: { name: string; qualifiedName?: string; range: LineRange }[],
		byName: Map<string, DefinitionLike[]>,
		byQualified: Map<string, DefinitionLike[]>
	): { backgrounds: CodeRegion[]; relatedCalls: typeof calls } {
		const regions: CodeRegion[] = [];

		const enclosingClass = findEnclosingClass(
			functions,
			unit.range.startLine
		);
		if (enclosingClass) {
			const classRegion = toClassRegion(relativePath, enclosingClass);
			if (!regions.some(existing => isSameRegion(existing, classRegion))) {
				regions.push(classRegion);
			}
		}

		const relatedCalls = calls.filter(call =>
			rangesOverlap(call.range, unit.range)
		);
		for (const call of relatedCalls) {
			const definition =
				findMatchingDefinition(call, byQualified) ??
				findMatchingDefinition(call, byName);
			if (!definition) {
				continue;
			}
			const region = toRegion(relativePath, definition);
			if (!regions.some(existing => isSameRegion(existing, region))) {
				regions.push(region);
			}
		}

		return { backgrounds: regions, relatedCalls };
	}
}

function rangesOverlap(
	a: LineRange,
	b: LineRange
): boolean {
	return a.startLine <= b.endLine && b.startLine <= a.endLine;
}

function toRegion(
	filePath: string,
	definition: DefinitionLike
): CodeRegion {
	return {
		filePath,
		range: { ...definition.range },
		label: definition.qualifiedName,
	};
}

function toClassRegion(
	filePath: string,
	definition: DefinitionLike
): CodeRegion {
	const startLine = definition.range.startLine;
	return {
		filePath,
		range: { startLine, endLine: startLine },
		label: definition.qualifiedName,
	};
}

function findMatchingDefinition(
	call: { name: string; qualifiedName?: string },
	map: Map<string, DefinitionLike[]>
): DefinitionLike | undefined {
	if (call.qualifiedName) {
		const qualified = map.get(call.qualifiedName);
		if (qualified?.length) {
			return qualified[0];
		}
	}
	const simple = map.get(call.name);
	return simple?.[0];
}

function isSameRegion(
	a: CodeRegion,
	b: CodeRegion
): boolean {
	return (
		a.filePath === b.filePath &&
		a.range.startLine === b.range.startLine &&
		a.range.endLine === b.range.endLine
	);
}

function findEnclosingClass(
	definitions: DefinitionLike[],
	line: number
): DefinitionLike | undefined {
	const candidates = definitions.filter(def =>
		def.kind === 'class' &&
		def.range.startLine <= line &&
		def.range.endLine >= line
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

function normalizeRelativePath(
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
