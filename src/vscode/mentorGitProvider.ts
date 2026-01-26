import * as path from 'path';
import * as vscode from 'vscode';
import { getFileContentAtHead } from '../core/gitShow';

export class MentorGitProvider implements vscode.TextDocumentContentProvider {
	private readonly _onDidChange =
		new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this._onDidChange.event;

	constructor(private readonly workspaceRoot: vscode.Uri) {}

	async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		const relativePath = decodeURIComponent(uri.path).replace(
			/^\//,
			''
		);
		const filePath = path.normalize(relativePath);
		return getFileContentAtHead(
			this.workspaceRoot.fsPath,
			filePath
		);
	}

	toVirtualUri(filePath: string): vscode.Uri {
		const relativePath = path
			.normalize(filePath)
			.replace(/\\/g, '/');
		return vscode.Uri.parse(
			`mentor-git:/${encodeURIComponent(relativePath)}`
		);
	}
}
