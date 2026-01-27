import * as vscode from 'vscode';

export class IntentViewProvider
	implements vscode.WebviewViewProvider, vscode.Disposable
{
	private readonly disposables: vscode.Disposable[] = [];
	private view?: vscode.WebviewView;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly onStart: (intent: string) => Promise<void> | void
	) {}

	resolveWebviewView(
		webviewView: vscode.WebviewView
	): void {
		this.view = webviewView;
		const webview = webviewView.webview;
		webview.options = {
			enableScripts: true,
		};
		webview.html = this.getHtml(webview, this.getStoredIntent());

		const subscription = webview.onDidReceiveMessage(
			async message => {
				if (!message || typeof message !== 'object') {
					return;
				}
				if (message.type === 'startTour') {
					const intent =
						typeof message.intent === 'string'
							? message.intent
							: '';
					await this.storeIntent(intent);
					await this.onStart(intent);
				}
				if (message.type === 'saveIntent') {
					const intent =
						typeof message.intent === 'string'
							? message.intent
							: '';
					await this.storeIntent(intent);
				}
			},
			undefined,
			this.disposables
		);

		this.disposables.push(subscription);
	}

	dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.disposables.length = 0;
	}

	private getStoredIntent(): string {
		return this.context.workspaceState.get<string>(
			'mentor.intent',
			''
		);
	}

	private async storeIntent(intent: string): Promise<void> {
		await this.context.workspaceState.update(
			'mentor.intent',
			intent.trim()
		);
		if (this.view) {
			this.view.webview.postMessage({
				type: 'intentStored',
				intent: intent.trim(),
			});
		}
	}

	private getHtml(webview: vscode.Webview, intent: string): string {
		const nonce = getNonce();
		const safeIntent = escapeHtml(intent);
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>MENTOR Intent</title>
	<style>
		body {
			font-family: var(--vscode-font-family);
			color: var(--vscode-foreground);
			padding: 12px;
		}
		textarea {
			width: 100%;
			min-height: 120px;
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border);
			border-radius: 4px;
			padding: 8px;
			box-sizing: border-box;
			resize: vertical;
		}
		button {
			margin-top: 8px;
			margin-right: 6px;
			padding: 6px 10px;
			border-radius: 4px;
			border: 1px solid var(--vscode-button-border, transparent);
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			cursor: pointer;
		}
		.secondary {
			background: var(--vscode-button-secondaryBackground);
			color: var(--vscode-button-secondaryForeground);
		}
		.hint {
			margin-top: 6px;
			font-size: 12px;
			opacity: 0.8;
		}
	</style>
</head>
<body>
	<label for="intent">Intent for AI-generated changes</label>
	<textarea id="intent" placeholder="e.g., Focus on bug fixes and risky logic changes.">${safeIntent}</textarea>
	<div>
		<button id="start">Start Tour</button>
		<button id="save" class="secondary">Save Intent</button>
	</div>
	<div class="hint">This intent will guide main tour explanations.</div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const intentEl = document.getElementById('intent');
		document.getElementById('start').addEventListener('click', () => {
			vscode.postMessage({ type: 'startTour', intent: intentEl.value });
		});
		document.getElementById('save').addEventListener('click', () => {
			vscode.postMessage({ type: 'saveIntent', intent: intentEl.value });
		});
		window.addEventListener('message', event => {
			const message = event.data;
			if (message && message.type === 'intentStored' && typeof message.intent === 'string') {
				intentEl.value = message.intent;
			}
		});
	</script>
</body>
</html>`;
	}
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/\"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function getNonce(): string {
	let text = '';
	const possible =
		'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 16; i += 1) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
