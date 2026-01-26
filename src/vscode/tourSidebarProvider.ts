import * as vscode from 'vscode';
import { TourController } from '../features/tour/tourController';
import { TourStep } from '../features/functionLevelExplanation/models';

export class TourSidebarProvider
	implements vscode.TreeDataProvider<TourSidebarItem>, vscode.Disposable
{
	private readonly _onDidChangeTreeData =
		new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private unsubscribe?: () => void;

	constructor(private readonly controller: TourController) {
		this.unsubscribe = this.controller.onDidChange(() => {
			this._onDidChangeTreeData.fire();
		});
	}

	getTreeItem(element: TourSidebarItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: TourSidebarItem): TourSidebarItem[] {
		if (element) {
			return [];
		}

		const state = this.controller.getState();
		const step = this.controller.getCurrentStep();
		const items: TourSidebarItem[] = [];

		items.push(
			new TourSidebarItem(
				'Start Tour',
				'mentor.startTour'
			),
			new TourSidebarItem('Stop Tour', 'mentor.stopTour'),
			new TourSidebarItem(
				'Previous Step',
				'mentor.previousStep'
			),
			new TourSidebarItem('Next Step', 'mentor.nextStep'),
			new TourSidebarItem(
				'Clear Explanations',
				'mentor.clearExplanations'
			),
			new TourSidebarItem(
				state.showBackground
					? 'Hide Background Tour'
					: 'Show Background Tour',
				'mentor.toggleBackgroundTour'
			)
		);

		items.push(new TourSidebarItem(''));
		items.push(
			new TourSidebarItem(
				`Status: ${state.status}`,
				undefined,
				true
			)
		);
		items.push(
			new TourSidebarItem(
				`Background: ${state.showBackground ? 'on' : 'off'}`,
				undefined,
				true
			)
		);

		if (step) {
			items.push(
				new TourSidebarItem(
					formatStepLabel(state.currentIndex, state.steps.length, step),
					undefined,
					true
				)
			);
			items.push(
				new TourSidebarItem(
					step.explanation || 'No explanation.',
					undefined,
					true
				)
			);
		} else {
			items.push(
				new TourSidebarItem(
					'No active step.',
					undefined,
					true
				)
			);
		}

		return items;
	}

	dispose(): void {
		this.unsubscribe?.();
		this._onDidChangeTreeData.dispose();
	}
}

class TourSidebarItem extends vscode.TreeItem {
	constructor(
		label: string,
		commandId?: string,
		readOnly = false
	) {
		super(label || ' ', vscode.TreeItemCollapsibleState.None);
		if (commandId) {
			this.command = {
				command: commandId,
				title: label,
			};
		}
		this.contextValue = readOnly ? 'mentorReadonly' : 'mentorCommand';
	}
}

function formatStepLabel(
	index: number,
	total: number,
	step: TourStep
): string {
	return `${step.type.toUpperCase()} · ${index + 1} / ${total}`;
}
