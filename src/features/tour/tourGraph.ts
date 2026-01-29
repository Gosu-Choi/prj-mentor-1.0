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
	containerName?: string;
	isOverall?: boolean;
	hidden?: boolean;
	identityKey?: string;
	layoutKey?: string;
	steps?: Array<{
		id: string;
		label: string;
		startLine: number;
		endLine: number;
	}>;
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
	const opGroupByKey = new Map<string, TourGraphNode>();
	const opStepsByKey = new Map<
		string,
		Array<{
			id: string;
			label: string;
			startLine: number;
			endLine: number;
			order: number;
		}>
	>();
	const stepOrder = new Map<string, number>();

	for (let i = 0; i < mainSteps.length; i += 1) {
		stepOrder.set(mainSteps[i].id, i + 1);
	}

	for (let i = 0; i < mainSteps.length; i += 1) {
		const step = mainSteps[i];
		const target = step.target as ChangeUnit;
		const kind = target.changeKind ?? 'unknown';
		if (kind === 'operation') {
			const identityRange = target.segmentId
				? `segment:${target.segmentId}`
				: target.definitionName
					? `range:${target.range.startLine}-${target.range.endLine}`
					: '';
			const identityName =
				target.qualifiedName ??
				target.symbolName ??
				target.definitionName ??
				'';
			const identity = identityRange || identityName || '';
			const key = identity
				? `op|${target.filePath}|${identity}`
				: `op|${target.filePath}|range:${target.range.startLine}-${target.range.endLine}|${step.id}`;
			let node = opGroupByKey.get(key);
			if (!node) {
				const label = target.symbolName ?? target.definitionName ?? 'Operation';
				const identityKey = buildIdentityKey(
					'operation',
					target.filePath,
					target.qualifiedName ?? label,
					target.segmentId ?? target.definitionName
				);
				const layoutKey = buildLayoutKey(
					target.filePath,
					resolveLayoutLabel(target)
				);
				node = {
					id: `op:${key}`,
					index: i,
					kind,
					label,
					filePath: target.filePath,
					startLine: target.range.startLine,
					endLine: target.range.endLine,
					elementKind: target.elementKind,
					qualifiedName: target.qualifiedName,
					containerName: target.containerName,
					isOverall: target.isOverall,
					identityKey,
					layoutKey,
				};
				opGroupByKey.set(key, node);
				nodes.push(node);
			} else {
				node.startLine = Math.min(node.startLine, target.range.startLine);
				node.endLine = Math.max(node.endLine, target.range.endLine);
			}
			const order = stepOrder.get(step.id) ?? i + 1;
			const list = opStepsByKey.get(key) ?? [];
			list.push({
				id: step.id,
				label: `Step ${order} · L${target.range.startLine}-${target.range.endLine}`,
				startLine: target.range.startLine,
				endLine: target.range.endLine,
				order,
			});
			opStepsByKey.set(key, list);
			nodeByStepId.set(step.id, node);
			continue;
		}

		const label =
			kind === 'definition'
				? target.definitionName ?? target.symbolName ?? 'Definition'
				: kind === 'global'
					? target.definitionName ?? target.symbolName ?? 'Global'
					: target.symbolName ?? 'Operation';
		const identityKey = buildIdentityKey(
			kind,
			target.filePath,
			target.qualifiedName ?? label
		);
		const layoutKey = buildLayoutKey(
			target.filePath,
			resolveLayoutLabel(target)
		);
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
			containerName: target.containerName,
			isOverall: target.isOverall,
			identityKey,
			layoutKey,
			steps: [
				{
					id: step.id,
					label: `Step ${stepOrder.get(step.id) ?? i + 1} · L${target.range.startLine}-${target.range.endLine}`,
					startLine: target.range.startLine,
					endLine: target.range.endLine,
				},
			],
		};
		nodes.push(node);
		nodeByStepId.set(step.id, node);
	}

	for (const [key, node] of opGroupByKey.entries()) {
		const stepsForKey = opStepsByKey.get(key) ?? [];
		stepsForKey.sort((a, b) => a.order - b.order);
		node.steps = stepsForKey.map(step => ({
			id: step.id,
			label: step.label,
			startLine: step.startLine,
			endLine: step.endLine,
		}));
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
		const fromNode = nodeByStepId.get(step.id);
		if (!fromNode) {
			continue;
		}
		const fromId = fromNode.id;

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

function buildIdentityKey(
	kind: TourGraphNode['kind'],
	filePath: string,
	label: string,
	suffix?: string
): string {
	const parts = [
		kind,
		filePath,
		label,
		suffix ?? '',
	];
	return parts.filter(Boolean).join('|');
}

function buildLayoutKey(filePath: string, label: string): string {
	const parts = [filePath, label];
	return parts.filter(Boolean).join('|');
}

function resolveLayoutLabel(target: ChangeUnit): string {
	if (target.qualifiedName) {
		return target.qualifiedName;
	}
	if (target.containerName && target.definitionName) {
		return `${target.containerName}.${target.definitionName}`;
	}
	if (target.containerName && target.symbolName) {
		return `${target.containerName}.${target.symbolName}`;
	}
	return target.definitionName ?? target.symbolName ?? '';
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
