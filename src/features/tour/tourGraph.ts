import { ChangeUnit, TourStep } from '../functionLevelExplanation/models';

export interface TourGraphNode {
	id: string;
	index: number;
	kind: 'operation' | 'definition' | 'unknown';
	label: string;
	filePath: string;
	startLine: number;
	endLine: number;
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
				: target.symbolName ?? 'Operation';
		const node: TourGraphNode = {
			id: step.id,
			index: i,
			kind,
			label,
			filePath: target.filePath,
			startLine: target.range.startLine,
			endLine: target.range.endLine,
		};
		nodes.push(node);
		nodeByStepId.set(step.id, node);
	}

	const defByFileAndName = new Map<string, TourGraphNode[]>();
	for (const node of nodes) {
		if (node.kind !== 'definition') {
			continue;
		}
		const key = `${node.filePath}|${node.label}`;
		const list = defByFileAndName.get(key) ?? [];
		list.push(node);
		defByFileAndName.set(key, list);
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
				const key = `${target.filePath}|${def.name}`;
				const defs = defByFileAndName.get(key) ?? [];
				for (const defNode of defs) {
					edges.push({
						from: fromId,
						to: defNode.id,
						type: 'op-to-def',
					});
				}
			}
			const callNames = collectCallNames(
				target.relatedCalls,
				target.diffText
			);
			for (const callName of callNames) {
				const key = `${target.filePath}|${callName}`;
				const defs = defByFileAndName.get(key) ?? [];
				for (const defNode of defs) {
					edges.push({
						from: fromId,
						to: defNode.id,
						type: 'op-to-def',
					});
				}
			}
			continue;
		}

		if (fromNode.kind === 'definition') {
			const callNames = collectCallNames(
				target.relatedCalls,
				target.diffText
			);
			for (const callName of callNames) {
				const key = `${target.filePath}|${callName}`;
				const defs = defByFileAndName.get(key) ?? [];
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
	}

	return {
		nodes,
		edges,
	};
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
