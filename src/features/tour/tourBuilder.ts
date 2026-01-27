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
	return [...steps].sort((a, b) => {
		const aKey = stepOrderingKey(a);
		const bKey = stepOrderingKey(b);
		if (aKey.definitionRank !== bKey.definitionRank) {
			return aKey.definitionRank - bKey.definitionRank;
		}
		if (aKey.filePath !== bKey.filePath) {
			return aKey.filePath.localeCompare(bKey.filePath);
		}
		return aKey.startLine - bKey.startLine;
	});
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
			? (step.target as { changeKind?: 'definition' | 'operation' })
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
	return [
		...orderedMainSteps.flatMap(step => step.dependsOn ?? []),
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
	return [
		...orderedMainSteps.flatMap(step => step.dependsOn ?? []),
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
	return `${region.filePath}|${region.range.startLine}-${region.range.endLine}`;
}
