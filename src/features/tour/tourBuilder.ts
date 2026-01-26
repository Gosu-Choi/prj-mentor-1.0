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

	return [...backgroundSteps, ...mainSteps];
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

	return [...backgroundSteps, ...mainSteps];
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
