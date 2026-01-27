import * as fs from 'fs/promises';
import * as path from 'path';
import { TourStep } from '../features/functionLevelExplanation/models';

const LOG_DIR = '.mentor';
const LOG_FILE = 'tour-debug.txt';

export async function writeTourDebugLog(
	workspaceRoot: string,
	steps: TourStep[]
): Promise<void> {
	const lines: string[] = [];
	lines.push('MENTOR Tour Debug Log');
	lines.push(`Steps: ${steps.length}`);
	lines.push(`Generated: ${new Date().toISOString()}`);
	lines.push('');

	for (const step of steps) {
		lines.push(`STEP ${step.id}`);
		lines.push(`Type: ${step.type}`);
		if ('diffText' in step.target) {
			const target = step.target;
			lines.push(`File: ${target.filePath}`);
			lines.push(`Range: ${target.range.startLine}-${target.range.endLine}`);
			lines.push(`ChangeKind: ${target.changeKind ?? 'unknown'}`);
			lines.push(`DefinitionName: ${target.definitionName ?? 'n/a'}`);
			lines.push(`DefinitionType: ${target.definitionType ?? 'n/a'}`);
			if (target.introducedDefinitions?.length) {
				lines.push(
					`IntroducedDefinitions: ${target.introducedDefinitions
						.map(def => `${def.name}(${def.type})@${def.range.startLine}-${def.range.endLine}`)
						.join(', ')}`
				);
			} else {
				lines.push('IntroducedDefinitions: none');
			}
			lines.push('DiffText:');
			lines.push(target.diffText || '(empty)');
		} else {
			const target = step.target;
			lines.push(`File: ${target.filePath}`);
			lines.push(`Range: ${target.range.startLine}-${target.range.endLine}`);
			lines.push(`Label: ${target.label ?? 'n/a'}`);
		}
		lines.push('Explanation:');
		lines.push(step.explanation || '(empty)');
		lines.push('---');
	}

	const filePath = path.join(workspaceRoot, LOG_DIR, LOG_FILE);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, lines.join('\n'), 'utf8');
}
