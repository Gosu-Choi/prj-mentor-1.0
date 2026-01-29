import { ExplanationGenerator } from '../functionLevelExplanation/explanationGenerator';
import {
	ChangeUnitGroup,
	CodeRegion,
	TourStep,
} from '../functionLevelExplanation/models';

export function buildTourSteps(groups: ChangeUnitGroup[]): TourStep[] {
	const mainSteps = buildMainSteps(groups);
	const steps = buildBackgroundStepsForTour(
		mainSteps,
		() => 'Background context placeholder.'
	);
	return steps;
}

export async function buildTourStepsWithExplanations(
	groups: ChangeUnitGroup[],
	generator: ExplanationGenerator,
	intent?: string
): Promise<TourStep[]> {
	const mainSteps = await buildMainStepsAsync(groups, generator, intent);
	const steps = await buildBackgroundStepsForTourAsync(
		mainSteps,
		region => generator.generateBackgroundForRegion(region)
	);
	return steps;
}

function reorderMainSteps(steps: TourStep[]): TourStep[] {
	const globals = steps.filter(isGlobalStep);
	const nonGlobals = steps.filter(step => !isGlobalStep(step));
	const orderedGlobals = [...globals].sort((a, b) => {
		const aTarget = a.target as { filePath: string; range: { startLine: number } };
		const bTarget = b.target as { filePath: string; range: { startLine: number } };
		if (aTarget.filePath !== bTarget.filePath) {
			return aTarget.filePath.localeCompare(bTarget.filePath);
		}
		return aTarget.range.startLine - bTarget.range.startLine;
	});
	return [...orderedGlobals, ...orderByGraph(nonGlobals)];
}

function stepOrderingKey(step: TourStep): {
	filePath: string;
	definitionRank: number;
	startLine: number;
} {
	const target = step.target as { filePath: string; range: { startLine: number; endLine: number }; diffText?: string };
	const diffText = 'diffText' in target ? target.diffText ?? '' : '';
	const explicitKind =
		'target' in step && 'changeKind' in (step.target as object)
			? (step.target as { changeKind?: 'definition' | 'operation' | 'global' })
					.changeKind
			: undefined;
	const isDefinition =
		explicitKind === 'definition'
			? true
			: explicitKind === 'operation'
				? false
				: detectDefinitionChange(diffText);
	return {
		filePath: target.filePath,
		definitionRank: isDefinition ? 1 : 0,
		startLine: target.range.startLine,
	};
}

type GraphNode = {
	step: TourStep;
	filePath: string;
	startLine: number;
	changeKind: 'definition' | 'operation' | 'global' | 'unknown';
	definitionName?: string;
};

function orderByGraph(steps: TourStep[]): TourStep[] {
	const nodes: GraphNode[] = steps.map(step => {
		const target = step.target as {
			filePath: string;
			range: { startLine: number };
			changeKind?: 'definition' | 'operation' | 'global';
			definitionName?: string;
		};
		return {
			step,
			filePath: target.filePath,
			startLine: target.range.startLine,
			changeKind: target.changeKind ?? 'unknown',
			definitionName: target.definitionName,
		};
	});

	const idByStep = new Map<TourStep, number>();
	nodes.forEach((node, index) => idByStep.set(node.step, index));

	const defByFileAndName = new Map<string, GraphNode[]>();
	for (const node of nodes) {
		if (
			(node.changeKind === 'definition' ||
				node.changeKind === 'global') &&
			node.definitionName
		) {
			const key = `${node.filePath}|${node.definitionName}`;
			const list = defByFileAndName.get(key) ?? [];
			list.push(node);
			defByFileAndName.set(key, list);
		}
	}

	const edges = new Map<number, Set<number>>();
	const undirected = new Map<number, Set<number>>();
	for (const node of nodes) {
		const target = node.step.target as {
			filePath: string;
			introducedDefinitions?: Array<{ name: string }>;
			relatedCalls?: Array<{ name: string; qualifiedName?: string }>;
			diffText?: string;
		};
		const opId = idByStep.get(node.step);
		if (opId === undefined) {
			continue;
		}

		if (node.changeKind === 'definition' || node.changeKind === 'global') {
			const linkedDefs: GraphNode[] = [];
			const relatedNames = collectRelatedNames(target);
			for (const name of relatedNames) {
				const key = `${node.filePath}|${name}`;
				const defs = defByFileAndName.get(key) ?? [];
				linkedDefs.push(...defs);
			}

			for (const defNode of linkedDefs) {
				const defId = idByStep.get(defNode.step);
				if (defId === undefined || defId === opId) {
					continue;
				}
				// Callee definition should be explained before caller definition.
				addEdge(edges, defId, opId);
				addUndirected(undirected, defId, opId);
			}
			continue;
		}

		if (node.changeKind !== 'operation') {
			continue;
		}

		const linkedDefs: GraphNode[] = [];
		for (const def of target.introducedDefinitions ?? []) {
			const key = `${node.filePath}|${def.name}`;
			const defs = defByFileAndName.get(key) ?? [];
			linkedDefs.push(...defs);
		}
		const relatedNames = collectRelatedNames(target);
		for (const name of relatedNames) {
			const key = `${node.filePath}|${name}`;
			const defs = defByFileAndName.get(key) ?? [];
			linkedDefs.push(...defs);
		}

		for (const defNode of linkedDefs) {
			const defId = idByStep.get(defNode.step);
			if (defId === undefined) {
				continue;
			}
			addEdge(edges, opId, defId);
			addUndirected(undirected, opId, defId);
		}
	}

	const components = buildComponents(nodes.length, undirected);
	const orderedComponents = components.sort((a, b) => {
		const aKey = componentSortKey(nodes, a);
		const bKey = componentSortKey(nodes, b);
		if (aKey.hasGlobal !== bKey.hasGlobal) {
			return aKey.hasGlobal ? -1 : 1;
		}
		if (aKey.hasOperation !== bKey.hasOperation) {
			return aKey.hasOperation ? -1 : 1;
		}
		if (aKey.filePath !== bKey.filePath) {
			return aKey.filePath.localeCompare(bKey.filePath);
		}
		return aKey.startLine - bKey.startLine;
	});

	const orderedSteps: TourStep[] = [];
	for (const component of orderedComponents) {
		const sorted = orderComponentLeafFirstBfs(nodes, component, edges);
		for (const nodeId of sorted) {
			orderedSteps.push(nodes[nodeId].step);
		}
	}
	return orderedSteps;
}

function addEdge(
	edges: Map<number, Set<number>>,
	from: number,
	to: number
): void {
	const set = edges.get(from) ?? new Set<number>();
	set.add(to);
	edges.set(from, set);
}

function addUndirected(
	undirected: Map<number, Set<number>>,
	a: number,
	b: number
): void {
	const aSet = undirected.get(a) ?? new Set<number>();
	aSet.add(b);
	undirected.set(a, aSet);
	const bSet = undirected.get(b) ?? new Set<number>();
	bSet.add(a);
	undirected.set(b, bSet);
}

function buildComponents(
	total: number,
	undirected: Map<number, Set<number>>
): number[][] {
	const visited = new Set<number>();
	const components: number[][] = [];
	for (let i = 0; i < total; i += 1) {
		if (visited.has(i)) {
			continue;
		}
		const stack = [i];
		const component: number[] = [];
		visited.add(i);
		while (stack.length > 0) {
			const current = stack.pop();
			if (current === undefined) {
				break;
			}
			component.push(current);
			const neighbors = undirected.get(current);
			if (!neighbors) {
				continue;
			}
			for (const neighbor of neighbors) {
				if (!visited.has(neighbor)) {
					visited.add(neighbor);
					stack.push(neighbor);
				}
			}
		}
		components.push(component);
	}
	return components;
}

function topoSortComponent(
	nodes: GraphNode[],
	component: number[],
	edges: Map<number, Set<number>>
): number[] {
	const inDegree = new Map<number, number>();
	for (const id of component) {
		inDegree.set(id, 0);
	}
	for (const [from, tos] of edges.entries()) {
		if (!inDegree.has(from)) {
			continue;
		}
		for (const to of tos) {
			if (inDegree.has(to)) {
				inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
			}
		}
	}

	const queue: number[] = [];
	for (const [id, degree] of inDegree.entries()) {
		if (degree === 0) {
			queue.push(id);
		}
	}
	queue.sort((a, b) => compareNodes(nodes[a], nodes[b]));

	const result: number[] = [];
	while (queue.length > 0) {
		const current = queue.shift();
		if (current === undefined) {
			break;
		}
		result.push(current);
		const neighbors = edges.get(current);
		if (!neighbors) {
			continue;
		}
		for (const next of neighbors) {
			if (!inDegree.has(next)) {
				continue;
			}
			const nextDegree = (inDegree.get(next) ?? 0) - 1;
			inDegree.set(next, nextDegree);
			if (nextDegree === 0) {
				queue.push(next);
				queue.sort((a, b) => compareNodes(nodes[a], nodes[b]));
			}
		}
	}

	if (result.length !== component.length) {
		return component.sort((a, b) => compareNodes(nodes[a], nodes[b]));
	}
	return result;
}

function compareNodes(a: GraphNode, b: GraphNode): number {
	const aRank = a.changeKind === 'global' ? 2 : a.changeKind === 'definition' ? 1 : 0;
	const bRank = b.changeKind === 'global' ? 2 : b.changeKind === 'definition' ? 1 : 0;
	if (aRank !== bRank) {
		return bRank - aRank;
	}
	if (a.filePath !== b.filePath) {
		return a.filePath.localeCompare(b.filePath);
	}
	return a.startLine - b.startLine;
}

function orderComponentLeafFirstBfs(
	nodes: GraphNode[],
	component: number[],
	edges: Map<number, Set<number>>
): number[] {
	const componentSet = new Set(component);
	const outEdges = new Map<number, number[]>();
	const inDegree = new Map<number, number>();

	for (const id of component) {
		outEdges.set(id, []);
		inDegree.set(id, 0);
	}

	for (const [from, tos] of edges.entries()) {
		if (!componentSet.has(from)) {
			continue;
		}
		for (const to of tos) {
			if (!componentSet.has(to)) {
				continue;
			}
			const list = outEdges.get(from);
			if (list) {
				list.push(to);
			}
			inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
		}
	}

	for (const list of outEdges.values()) {
		list.sort((a, b) => compareNodes(nodes[a], nodes[b]));
	}

	const leaves = component.filter(id => (outEdges.get(id)?.length ?? 0) === 0);
	leaves.sort((a, b) => compareNodes(nodes[a], nodes[b]));

	const ordered: number[] = [];
	const visited = new Set<number>();

	for (const leaf of leaves) {
		ordered.push(leaf);
		visited.add(leaf);
	}

	const roots = component.filter(id => (inDegree.get(id) ?? 0) === 0);
	roots.sort((a, b) => compareNodes(nodes[a], nodes[b]));
	const queue = [...roots];

	while (queue.length > 0) {
		const current = queue.shift();
		if (current === undefined) {
			break;
		}
		if (!visited.has(current)) {
			ordered.push(current);
			visited.add(current);
		}
		const nexts = outEdges.get(current) ?? [];
		for (const next of nexts) {
			if (!visited.has(next)) {
				queue.push(next);
			}
		}
	}

	const remaining = component.filter(id => !visited.has(id));
	remaining.sort((a, b) => compareNodes(nodes[a], nodes[b]));
	for (const id of remaining) {
		ordered.push(id);
		visited.add(id);
	}

	return ordered;
}

function componentSortKey(nodes: GraphNode[], component: number[]): {
	hasGlobal: boolean;
	hasOperation: boolean;
	filePath: string;
	startLine: number;
} {
	let best = nodes[component[0]];
	let hasGlobal = best.changeKind === 'global';
	let hasOperation = best.changeKind === 'operation';
	for (const id of component) {
		const node = nodes[id];
		if (node.changeKind === 'global') {
			hasGlobal = true;
		}
		if (node.changeKind === 'operation') {
			hasOperation = true;
		}
		if (
			node.changeKind === 'global' &&
			best.changeKind !== 'global'
		) {
			best = node;
			continue;
		}
		if (node.filePath < best.filePath) {
			best = node;
			continue;
		}
		if (
			node.filePath === best.filePath &&
			node.startLine < best.startLine
		) {
			best = node;
		}
	}
	return {
		hasGlobal,
		hasOperation,
		filePath: best.filePath,
		startLine: best.startLine,
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
			const methodMatches = text.matchAll(/(?:self|this)\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g);
			for (const match of methodMatches) {
				const name = match[1];
				if (name) {
					names.add(name);
				}
			}
			const attrMatches = text.matchAll(/(?:self|this)\.([A-Za-z_][A-Za-z0-9_]*)/g);
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

function isGlobalStep(step: TourStep): boolean {
	if (step.type !== 'main') {
		return false;
	}
	if (!('diffText' in step.target)) {
		return false;
	}
	return step.target.changeKind === 'global';
}

function collectRelatedNames(target: {
	relatedCalls?: Array<{ name: string; qualifiedName?: string }>;
	diffText?: string;
}): Set<string> {
	const names = collectCallNames(target.relatedCalls, target.diffText);
	const identifiers = collectIdentifierNames(target.diffText);
	for (const name of identifiers) {
		names.add(name);
	}
	return names;
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

function detectDefinitionChange(diffText: string): boolean {
	const addedLines = diffText
		.split(/\r?\n/)
		.filter(line => line.startsWith('+') && !line.startsWith('+++'));
	for (const line of addedLines) {
		const text = line.slice(1).trim();
		if (
			/^(export\s+)?(async\s+)?function\s+\w+/.test(text) ||
			/^(export\s+)?class\s+\w+/.test(text) ||
			/^(export\s+)?(const|let|var)\s+\w+\s*=\s*\(?.*?\)?\s*=>/.test(text)
		) {
			return true;
		}
	}
	return false;
}

function buildMainSteps(groups: ChangeUnitGroup[]): TourStep[] {
	const mainSteps: TourStep[] = [];
	let stepIndex = 0;

	for (const group of groups) {
		for (const unit of group.units) {
			stepIndex += 1;
			const mainStep: TourStep = {
				id: `main-${stepIndex}`,
				type: 'main',
				target: unit,
				explanation: 'Main change explanation placeholder.',
			};
			mainSteps.push(mainStep);
		}
	}

	return mainSteps;
}

async function buildMainStepsAsync(
	groups: ChangeUnitGroup[],
	generator: ExplanationGenerator,
	intent?: string
): Promise<TourStep[]> {
	const mainSteps: TourStep[] = [];
	let stepIndex = 0;

	for (const group of groups) {
		for (const unit of group.units) {
			stepIndex += 1;
			const mainExplanation =
				await generator.generateMainExplanationWithIntent(
					unit,
					intent
				);
			const mainStep: TourStep = {
				id: `main-${stepIndex}`,
				type: 'main',
				target: unit,
				explanation: mainExplanation,
			};
			mainSteps.push(mainStep);
		}
	}

	return mainSteps;
}

function getBackgroundRegions(
	unit: ChangeUnitGroup['units'][number]
): CodeRegion[] {
	if (unit.backgroundRegions?.length) {
		return unit.backgroundRegions;
	}
	return [];
}

function buildBackgroundStepsForTour(
	mainSteps: TourStep[],
	getExplanation: (region: CodeRegion) => string
): TourStep[] {
	const { orderedMainSteps, regionSteps } =
		collectBackgroundSteps(mainSteps);
	for (const entry of regionSteps) {
		entry.step.explanation = getExplanation(entry.step.target as CodeRegion);
	}
	const orderedBackground = orderBackgroundSteps(
		regionSteps.map(entry => entry.step)
	);
	return [
		...orderedBackground,
		...orderedMainSteps,
	];
}

async function buildBackgroundStepsForTourAsync(
	mainSteps: TourStep[],
	getExplanation: (region: CodeRegion) => Promise<string>
): Promise<TourStep[]> {
	const { orderedMainSteps, regionSteps } =
		collectBackgroundSteps(mainSteps);
	for (const entry of regionSteps) {
		entry.step.explanation = await getExplanation(
			entry.step.target as CodeRegion
		);
	}
	const orderedBackground = orderBackgroundSteps(
		regionSteps.map(entry => entry.step)
	);
	return [
		...orderedBackground,
		...orderedMainSteps,
	];
}

function collectBackgroundSteps(mainSteps: TourStep[]): {
	orderedMainSteps: TourStep[];
	regionSteps: Array<{ key: string; step: TourStep }>;
} {
	const orderedMainSteps = reorderMainSteps(mainSteps);
	const regionSteps: Array<{ key: string; step: TourStep }> = [];
	const regionByKey = new Map<string, TourStep>();
	for (const main of orderedMainSteps) {
		const target = main.target as {
			backgroundRegions?: CodeRegion[];
		};
		const regions = target.backgroundRegions ?? [];
		const dependencies: TourStep[] = [];
		for (const region of regions) {
			const key = buildRegionKey(region);
			let step = regionByKey.get(key);
			if (!step) {
				step = {
					id: `bg-${regionSteps.length + 1}`,
					type: 'background',
					target: region,
					explanation: '',
				};
				regionByKey.set(key, step);
				regionSteps.push({ key, step });
			}
			dependencies.push(step);
		}
		if (dependencies.length > 0) {
			main.dependsOn = dependencies;
		}
	}
	return { orderedMainSteps, regionSteps };
}

function buildRegionKey(region: CodeRegion): string {
	return `${region.filePath}|${region.range.startLine}-${region.range.endLine}|${region.label ?? ''}`;
}

function orderBackgroundSteps(steps: TourStep[]): TourStep[] {
	return [...steps].sort((a, b) => {
		const aTarget = a.target as CodeRegion;
		const bTarget = b.target as CodeRegion;
		const aRank = backgroundRank(aTarget.label);
		const bRank = backgroundRank(bTarget.label);
		if (aRank !== bRank) {
			return aRank - bRank;
		}
		if (aTarget.filePath !== bTarget.filePath) {
			return aTarget.filePath.localeCompare(bTarget.filePath);
		}
		return aTarget.range.startLine - bTarget.range.startLine;
	});
}

function backgroundRank(label?: string): number {
	if (!label) {
		return 1;
	}
	if (/^[A-Z][A-Za-z0-9_]*$/.test(label)) {
		return 0;
	}
	if (label.includes('.')) {
		return 1;
	}
	return 1;
}
