import { ChangeUnit, TourStep } from '../functionLevelExplanation/models';

export interface TourGraphNode {
	id: string;
	index: number;
	kind: 'operation' | 'definition' | 'global' | 'unknown';
	label: string;
	filePath: string;
	startLine: number;
	endLine: number;
	elementKind?: ChangeUnit['elementKind'];
	qualifiedName?: string;
	isOverall?: boolean;
	hidden?: boolean;
}

export interface TourGraphEdge {
	from: string;
	to: string;
	type: 'op-to-def' | 'def-to-def';
}

export interface TourGraph {
	nodes: TourGraphNode[];
	edges: TourGraphEdge[];
}

export function buildTourGraph(steps: TourStep[]): TourGraph {
	const mainSteps = steps.filter(step => step.type === 'main');
	const nodes: TourGraphNode[] = [];
	const nodeByStepId = new Map<string, TourGraphNode>();

	for (let i = 0; i < mainSteps.length; i += 1) {
		const step = mainSteps[i];
		const target = step.target as ChangeUnit;
		const kind = target.changeKind ?? 'unknown';
		const label =
			kind === 'definition'
				? target.definitionName ?? target.symbolName ?? 'Definition'
				: kind === 'global'
					? target.definitionName ?? target.symbolName ?? 'Global'
					: target.symbolName ?? 'Operation';
		const node: TourGraphNode = {
			id: step.id,
			index: i,
			kind,
			label,
			filePath: target.filePath,
			startLine: target.range.startLine,
			endLine: target.range.endLine,
			elementKind: target.elementKind ?? (kind === 'global' ? 'global' : undefined),
			qualifiedName: target.qualifiedName,
			isOverall: target.isOverall,
		};
		nodes.push(node);
		nodeByStepId.set(step.id, node);
	}

	const defByFileAndName = new Map<string, TourGraphNode[]>();
	const defByFileAndQualified = new Map<string, TourGraphNode[]>();
	const defByNameGlobal = new Map<string, TourGraphNode[]>();
	const classByFileAndName = new Map<string, TourGraphNode[]>();
	for (const node of nodes) {
		const canResolve =
			node.elementKind !== undefined ||
			node.kind === 'definition' ||
			node.kind === 'global';
		if (!canResolve) {
			continue;
		}
		const key = `${node.filePath}|${node.label}`;
		const list = defByFileAndName.get(key) ?? [];
		list.push(node);
		defByFileAndName.set(key, list);
		const globalList = defByNameGlobal.get(node.label) ?? [];
		globalList.push(node);
		defByNameGlobal.set(node.label, globalList);
		if (node.qualifiedName) {
			const qKey = `${node.filePath}|${node.qualifiedName}`;
			const qList = defByFileAndQualified.get(qKey) ?? [];
			qList.push(node);
			defByFileAndQualified.set(qKey, qList);
		}
		if (node.elementKind === 'class') {
			const classList = classByFileAndName.get(key) ?? [];
			classList.push(node);
			classByFileAndName.set(key, classList);
		}
	}

	const edges: TourGraphEdge[] = [];
	for (const step of mainSteps) {
		const target = step.target as ChangeUnit;
		const fromId = step.id;
		const fromNode = nodeByStepId.get(fromId);
		if (!fromNode) {
			continue;
		}

		if (fromNode.kind === 'operation') {
			for (const def of target.introducedDefinitions ?? []) {
				const defs = resolveDefinitions(
					defByFileAndQualified,
					defByFileAndName,
					defByNameGlobal,
					target.filePath,
					def.name,
					undefined
				);
				for (const defNode of defs) {
					edges.push({
						from: defNode.id,
						to: fromId,
						type: 'op-to-def',
					});
				}
			}
			const related = collectRelatedCalls(target);
			for (const call of related) {
				const defs = resolveDefinitions(
					defByFileAndQualified,
					defByFileAndName,
					defByNameGlobal,
					target.filePath,
					call.name,
					call.qualifiedName
				);
				for (const defNode of defs) {
					edges.push({
						from: defNode.id,
						to: fromId,
						type: 'op-to-def',
					});
				}
			}
			continue;
		}

		if (fromNode.kind === 'definition' || (target.isOverall && target.relatedCalls?.length)) {
			const related = collectRelatedCalls(target);
			for (const call of related) {
				const defs = resolveDefinitions(
					defByFileAndQualified,
					defByFileAndName,
					defByNameGlobal,
					target.filePath,
					call.name,
					call.qualifiedName
				);
				for (const defNode of defs) {
					if (defNode.id === fromId) {
						continue;
					}
					edges.push({
						from: defNode.id,
						to: fromId,
						type: 'def-to-def',
					});
				}
			}
		}

		if (target.isOverall && target.elementKind === 'method' && target.containerName) {
			const key = `${target.filePath}|${target.containerName}`;
			const classes = classByFileAndName.get(key) ?? [];
			for (const classNode of classes) {
				if (classNode.id === fromId) {
					continue;
				}
				edges.push({
					from: fromId,
					to: classNode.id,
					type: 'def-to-def',
				});
			}
		}
	}

	return {
		nodes,
		edges,
	};
}

function resolveDefinitions(
	byQualified: Map<string, TourGraphNode[]>,
	byName: Map<string, TourGraphNode[]>,
	byNameGlobal: Map<string, TourGraphNode[]>,
	filePath: string,
	name: string,
	qualifiedName?: string
): TourGraphNode[] {
	if (qualifiedName) {
		const qKey = `${filePath}|${qualifiedName}`;
		const qualified = byQualified.get(qKey);
		if (qualified && qualified.length > 0) {
			return qualified;
		}
	}
	const key = `${filePath}|${name}`;
	const local = byName.get(key);
	if (local && local.length > 0) {
		return local;
	}
	const global = byNameGlobal.get(name);
	if (global && global.length === 1) {
		return global;
	}
	return [];
}

function collectCallNames(
	relatedCalls: Array<{ name: string; qualifiedName?: string }> | undefined,
	diffText: string | undefined
): Set<string> {
	const names = new Set<string>();
	for (const call of relatedCalls ?? []) {
		if (call.name) {
			names.add(call.name);
		}
		if (call.qualifiedName && call.qualifiedName !== call.name) {
			const parts = call.qualifiedName.split('.');
			for (const part of parts) {
				if (part && part !== 'self' && part !== 'this') {
					names.add(part);
				}
			}
		}
	}
	if (diffText) {
		const lines = diffText.split(/\r?\n/);
		for (const line of lines) {
			if (!line.startsWith('+')) {
				continue;
			}
			const text = line.slice(1);
			const callMatches = text.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g);
			for (const match of callMatches) {
				const name = match[1];
				if (name && name !== 'if' && name !== 'for' && name !== 'while') {
					names.add(name);
				}
			}
			const methodMatches = text.matchAll(
				/(?:self|this)\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g
			);
			for (const match of methodMatches) {
				const name = match[1];
				if (name) {
					names.add(name);
				}
			}
			const attrMatches = text.matchAll(
				/(?:self|this)\.([A-Za-z_][A-Za-z0-9_]*)/g
			);
			for (const match of attrMatches) {
				const name = match[1];
				if (name) {
					names.add(name);
				}
			}
		}
	}
	return names;
}

function collectRelatedCalls(
	target: ChangeUnit
): Array<{ name: string; qualifiedName?: string }> {
	const calls: Array<{ name: string; qualifiedName?: string }> =
		(target.relatedCalls ?? []).map(call => ({
			name: call.name,
			qualifiedName: call.qualifiedName,
		}));
	const names = collectIdentifierNames(target.diffText);
	for (const name of names) {
		calls.push({ name });
	}
	return calls;
}

function collectIdentifierNames(diffText: string | undefined): Set<string> {
	const names = new Set<string>();
	if (!diffText) {
		return names;
	}
	const lines = diffText.split(/\r?\n/);
	for (const line of lines) {
		if (!line.startsWith('+')) {
			continue;
		}
		const text = sanitizeLine(line.slice(1));
		const matches = text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g);
		for (const match of matches) {
			const name = match[1];
			if (isIgnoredIdentifier(name)) {
				continue;
			}
			names.add(name);
		}
	}
	return names;
}

function sanitizeLine(text: string): string {
	return text.replace(/(["'])(?:\\.|(?!\1).)*\1/g, ' ');
}

function isIgnoredIdentifier(name: string): boolean {
	if (!name) {
		return true;
	}
	const keywords = new Set([
		'if',
		'for',
		'while',
		'return',
		'const',
		'let',
		'var',
		'function',
		'class',
		'def',
		'async',
		'await',
		'new',
		'import',
		'from',
		'export',
		'as',
		'this',
		'self',
		'true',
		'false',
		'null',
		'undefined',
	]);
	return keywords.has(name);
}
