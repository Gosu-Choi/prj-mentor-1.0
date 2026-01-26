import * as vscode from 'vscode';
import {
	ChangeUnit,
	CodeRegion,
	TourState,
} from '../features/functionLevelExplanation/models';

export class DebugInfoService {
	private readonly channel = vscode.window.createOutputChannel(
		'MENTOR Debug'
	);

	show(state: TourState): void {
		const mainSteps = state.steps.filter(
			step => step.type === 'main'
		);

		this.channel.clear();
		this.channel.appendLine('MENTOR Debug: Related Functions');
		this.channel.appendLine(`Main steps: ${mainSteps.length}`);
		this.channel.appendLine('');

		for (const step of mainSteps) {
			const target = step.target as ChangeUnit;
			this.channel.appendLine(
				`Main ${step.id}: ${target.filePath} (${formatRange(
					target
				)})`
			);
			this.channel.appendLine(
				`Symbol: ${target.symbolName ?? 'unknown'}`
			);

			const relatedCalls = target.relatedCalls ?? [];
			if (relatedCalls.length === 0) {
				this.channel.appendLine('Related calls: none');
			} else {
				this.channel.appendLine(
					`Related calls: ${relatedCalls.length}`
				);
				for (const call of relatedCalls) {
					this.channel.appendLine(
						`- ${call.qualifiedName ?? call.name} (${formatLineRange(
							call.range
						)})`
					);
				}
			}

			const related = target.backgroundRegions ?? [];
			if (related.length === 0) {
				this.channel.appendLine('Resolved helpers: none');
			} else {
				this.channel.appendLine(
					`Resolved helpers: ${related.length}`
				);
				for (const region of related) {
					this.channel.appendLine(
						`- ${region.label ?? 'unknown'} (${formatRange(
							region
						)})`
					);
				}
			}
			this.channel.appendLine('');
		}

		this.channel.show(true);
	}

	dispose(): void {
		this.channel.dispose();
	}
}

function formatRange(region: CodeRegion): string {
	return `${region.range.startLine}-${region.range.endLine}`;
}

function formatLineRange(range: { startLine: number; endLine: number }): string {
	return `${range.startLine}-${range.endLine}`;
}
