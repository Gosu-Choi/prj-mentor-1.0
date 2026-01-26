import { ExplanationGenerator } from '../functionLevelExplanation/explanationGenerator';
import { ChangeUnitGroup, CodeRegion, TourStep } from '../functionLevelExplanation/models';

export function buildTourSteps(groups: ChangeUnitGroup[]): TourStep[] {
	const backgroundSteps: TourStep[] = [];
	const mainSteps: TourStep[] = [];
	let stepIndex = 0;

	for (const group of groups) {
		for (const unit of group.units) {
			stepIndex += 1;
			const backgroundStep: TourStep = {
				id: `bg-${stepIndex}`,
				type: 'background',
				target: toCodeRegion(unit),
				// GPT-based explanation generation will be plugged in here later.
				explanation: 'Background context placeholder.',
			};

			const mainStep: TourStep = {
				id: `main-${stepIndex}`,
				type: 'main',
				target: unit,
				// GPT-based explanation generation will be plugged in here later.
				explanation: 'Main change explanation placeholder.',
				dependsOn: [backgroundStep],
			};

			backgroundSteps.push(backgroundStep);
			mainSteps.push(mainStep);
		}
	}

	const orderedMainSteps = reorderMainSteps(mainSteps);
	const orderedBackgroundSteps = orderedMainSteps.map(step => {
		const background = step.dependsOn?.[0];
		return background ?? {
			id: `bg-orphan-${step.id}`,
			type: 'background' as const,
			target: toCodeRegion(step.target as { filePath: string; range: { startLine: number; endLine: number } }),
			explanation: 'Background context placeholder.',
		};
	});

	return [...orderedBackgroundSteps, ...orderedMainSteps];
}

export async function buildTourStepsWithExplanations(
	groups: ChangeUnitGroup[],
	generator: ExplanationGenerator
): Promise<TourStep[]> {
	const backgroundSteps: TourStep[] = [];
	const mainSteps: TourStep[] = [];
	let stepIndex = 0;

	for (const group of groups) {
		for (const unit of group.units) {
			stepIndex += 1;
			const mainExplanation = await generator.generateMainExplanation(
				unit
			);
			const backgroundExplanation =
				await generator.generateBackgroundExplanation(
					unit,
					mainExplanation
				);

			const backgroundStep: TourStep = {
				id: `bg-${stepIndex}`,
				type: 'background',
				target: toCodeRegion(unit),
				explanation: backgroundExplanation,
			};

			const mainStep: TourStep = {
				id: `main-${stepIndex}`,
				type: 'main',
				target: unit,
				explanation: mainExplanation,
				dependsOn: [backgroundStep],
			};

			backgroundSteps.push(backgroundStep);
			mainSteps.push(mainStep);
		}
	}

	const orderedMainSteps = reorderMainSteps(mainSteps);
	const orderedBackgroundSteps = orderedMainSteps.map(step => {
		const background = step.dependsOn?.[0];
		return background ?? {
			id: `bg-orphan-${step.id}`,
			type: 'background' as const,
			target: toCodeRegion(step.target as { filePath: string; range: { startLine: number; endLine: number } }),
			explanation: 'Background context placeholder.',
		};
	});

	return [...orderedBackgroundSteps, ...orderedMainSteps];
}

function toCodeRegion(unit: {
	filePath: string;
	range: { startLine: number; endLine: number };
}): CodeRegion {
	return {
		filePath: unit.filePath,
		range: { ...unit.range },
		label: 'Background context',
	};
}

function reorderMainSteps(steps: TourStep[]): TourStep[] {
	return [...steps].sort((a, b) => {
		const aKey = stepOrderingKey(a);
		const bKey = stepOrderingKey(b);
		if (aKey.filePath !== bKey.filePath) {
			return aKey.filePath.localeCompare(bKey.filePath);
		}
		if (aKey.definitionRank !== bKey.definitionRank) {
			return aKey.definitionRank - bKey.definitionRank;
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
	const isDefinition = detectDefinitionChange(diffText);
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
