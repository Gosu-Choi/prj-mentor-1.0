import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { ChangeUnit, ChangeUnitGroup, LineRange } from './models';

interface GroupingOptions {
	workspaceRoot: string;
	proximityThreshold?: number;
}

export function groupChangeUnits(
	units: ChangeUnit[],
	options: GroupingOptions
): ChangeUnitGroup[] {
	const proximityThreshold = options.proximityThreshold ?? 5;
	const byFile = new Map<string, ChangeUnit[]>();

	for (const unit of units) {
		const list = byFile.get(unit.filePath) ?? [];
		list.push(unit);
		byFile.set(unit.filePath, list);
	}

	const groups: ChangeUnitGroup[] = [];

	for (const [filePath, fileUnits] of byFile.entries()) {
		const absolutePath = path.isAbsolute(filePath)
			? filePath
			: path.join(options.workspaceRoot, filePath);
		const sourceText = safeReadFile(absolutePath);
		const sourceFile = sourceText
			? ts.createSourceFile(
					absolutePath,
					sourceText,
					ts.ScriptTarget.Latest,
					true
				)
			: undefined;

		for (const unit of fileUnits) {
			if (sourceFile) {
				const symbolName = findEnclosingSymbolName(
					sourceFile,
					unit.range.startLine
				);
				if (symbolName) {
					unit.symbolName = symbolName;
				}
			}
		}

		fileUnits.sort(
			(a, b) => a.range.startLine - b.range.startLine
		);

		let groupIndex = 0;
		let currentGroup: ChangeUnitGroup | null = null;

		for (const unit of fileUnits) {
			if (
				currentGroup &&
				currentGroup.filePath === unit.filePath &&
				currentGroup.symbolName === unit.symbolName &&
				unit.range.startLine - currentGroup.range.endLine <=
					proximityThreshold
			) {
				currentGroup.units.push(unit);
				currentGroup.range = mergeRanges(
					currentGroup.range,
					unit.range
				);
				unit.semanticGroupId = currentGroup.id;
				continue;
			}

			groupIndex += 1;
			const id = `${unit.filePath}::${unit.symbolName ?? 'top-level'}::${groupIndex}`;
			currentGroup = {
				id,
				filePath: unit.filePath,
				symbolName: unit.symbolName,
				range: { ...unit.range },
				units: [unit],
			};
			unit.semanticGroupId = id;
			groups.push(currentGroup);
		}
	}

	return groups;
}

function safeReadFile(absolutePath: string): string | undefined {
	try {
		if (!fs.existsSync(absolutePath)) {
			return undefined;
		}
		return fs.readFileSync(absolutePath, 'utf8');
	} catch {
		return undefined;
	}
}

function findEnclosingSymbolName(
	sourceFile: ts.SourceFile,
	line: number
): string | undefined {
	const position = ts.getPositionOfLineAndCharacter(
		sourceFile,
		Math.max(0, line - 1),
		0
	);

	let best: { name: string; span: number } | undefined;

	const visit = (node: ts.Node) => {
		if (position < node.pos || position > node.end) {
			return;
		}

		const name = getNodeName(node);
		if (name) {
			const span = node.end - node.pos;
			if (!best || span < best.span) {
				best = { name, span };
			}
		}

		ts.forEachChild(node, visit);
	};

	visit(sourceFile);

	return best?.name;
}

function getNodeName(node: ts.Node): string | undefined {
	if (ts.isClassDeclaration(node) && node.name) {
		return node.name.text;
	}
	if (ts.isFunctionDeclaration(node) && node.name) {
		return node.name.text;
	}
	if (ts.isMethodDeclaration(node) && node.name) {
		return node.name.getText();
	}
	if (ts.isInterfaceDeclaration(node) && node.name) {
		return node.name.text;
	}
	if (ts.isEnumDeclaration(node) && node.name) {
		return node.name.text;
	}
	if (ts.isTypeAliasDeclaration(node) && node.name) {
		return node.name.text;
	}
	if (ts.isVariableDeclaration(node) && node.name) {
		return node.name.getText();
	}
	return undefined;
}

function mergeRanges(a: LineRange, b: LineRange): LineRange {
	return {
		startLine: Math.min(a.startLine, b.startLine),
		endLine: Math.max(a.endLine, b.endLine),
	};
}
