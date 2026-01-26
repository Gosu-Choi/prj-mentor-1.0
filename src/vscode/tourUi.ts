import * as vscode from 'vscode';
import { ChangeUnit, CodeRegion, TourStep } from '../core/models';
import { TourController } from '../core/tourController';
import { MentorGitProvider } from './mentorGitProvider';

export class TourUi implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	private unsubscribe: (() => void) | undefined;
	private readonly commentController: vscode.CommentController;
	private activeThread: vscode.CommentThread | undefined;

	constructor(
		private readonly controller: TourController,
		private readonly workspaceRoot: vscode.Uri,
		private readonly gitProvider: MentorGitProvider
	) {
		this.commentController = vscode.comments.createCommentController(
			'mentorTour',
			'MENTOR Tour'
		);

		this.unsubscribe = this.controller.onDidChange(() => {
			void this.render();
		});
	}

	dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.commentController.dispose();
		this.activeThread?.dispose();
		this.unsubscribe?.();
	}

	private async render(): Promise<void> {
		const state = this.controller.getState();
		const step = this.controller.getCurrentStep();

		if (state.status === 'idle' || state.status === 'completed') {
			this.clearHighlights();
			this.clearCommentThread();
			return;
		}

		if (!step) {
			this.clearHighlights();
			this.clearCommentThread();
			return;
		}

		await this.highlightStep(step);
		this.showComment(step);
	}

	private clearHighlights(): void {
		return;
	}

	private async highlightStep(step: TourStep): Promise<void> {
		const target = normalizeTarget(step.target);
		const originalUri = this.gitProvider.toVirtualUri(
			target.filePath
		);
		const revisedUri = vscode.Uri.joinPath(
			this.workspaceRoot,
			target.filePath
		);

		try {
			await vscode.commands.executeCommand(
				'vscode.diff',
				originalUri,
				revisedUri,
				`MENTOR: ${target.filePath}`
			);

			const targetUri =
				step.type === 'background' ? originalUri : revisedUri;
			const editor = vscode.window.visibleTextEditors.find(
				visible =>
					visible.document.uri.toString() ===
					targetUri.toString()
			);

			if (!editor) {
				return;
			}

			const range = toEditorRange(editor.document, target.range);
			editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: 'Unable to open document for highlighting.';
			void vscode.window.showWarningMessage(message);
		}
	}

	private showComment(step: TourStep): void {
		this.clearCommentThread();
		const target = normalizeTarget(step.target);
		const targetUri =
			step.type === 'background'
				? this.gitProvider.toVirtualUri(target.filePath)
				: vscode.Uri.joinPath(this.workspaceRoot, target.filePath);
		const range = toEditorRangeFromLines(target.range);
		const comment: vscode.Comment = {
			body: step.explanation,
			mode: vscode.CommentMode.Preview,
			author: { name: 'MENTOR' },
		};
		this.activeThread = this.commentController.createCommentThread(
			targetUri,
			range,
			[comment]
		);
	}

	private clearCommentThread(): void {
		this.activeThread?.dispose();
		this.activeThread = undefined;
	}
}

function normalizeTarget(target: ChangeUnit | CodeRegion): CodeRegion {
	if ('diffText' in target) {
		return {
			filePath: target.filePath,
			range: { ...target.range },
			label: target.symbolName,
		};
	}
	return target;
}

function toEditorRange(
	document: vscode.TextDocument,
	range: { startLine: number; endLine: number }
): vscode.Range {
	const startLine = Math.max(0, range.startLine - 1);
	const endLine = Math.max(startLine, range.endLine - 1);
	const start = new vscode.Position(startLine, 0);
	const end = document.lineAt(endLine).range.end;
	return new vscode.Range(start, end);
}

function toEditorRangeFromLines(range: {
	startLine: number;
	endLine: number;
}): vscode.Range {
	const start = new vscode.Position(Math.max(0, range.startLine - 1), 0);
	const end = new vscode.Position(Math.max(0, range.endLine - 1), 0);
	return new vscode.Range(start, end);
}
