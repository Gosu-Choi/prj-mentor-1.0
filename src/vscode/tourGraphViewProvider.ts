import * as vscode from 'vscode';
import { TourController } from '../features/tour/tourController';
import { buildTourGraph, TourGraph } from '../features/tour/tourGraph';

export class TourGraphViewProvider
	implements vscode.WebviewViewProvider, vscode.Disposable
{
	private readonly disposables: vscode.Disposable[] = [];
	private view?: vscode.WebviewView;
	private unsubscribe?: () => void;

	constructor(private readonly controller: TourController) {
		this.unsubscribe = this.controller.onDidChange(() => {
			this.updateGraph();
		});
	}

	resolveWebviewView(
		webviewView: vscode.WebviewView
	): void {
		this.view = webviewView;
		const webview = webviewView.webview;
		webview.options = {
			enableScripts: true,
		};
		webview.html = this.getHtml(webview);

		const subscription = webview.onDidReceiveMessage(message => {
			if (!message || typeof message !== 'object') {
				return;
			}
			if (message.type === 'selectStep' && typeof message.id === 'string') {
				const state = this.controller.getState();
				const index = state.steps.findIndex(step => step.id === message.id);
				if (index >= 0) {
					this.controller.setSteps(state.steps);
					this.controller.start();
					for (let i = 0; i < index; i += 1) {
						this.controller.next();
					}
				}
			}
		});

		this.disposables.push(subscription);
		this.updateGraph();
	}

	dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.disposables.length = 0;
		this.unsubscribe?.();
	}

	private updateGraph(): void {
		if (!this.view) {
			return;
		}
		const state = this.controller.getState();
		const graph = applyGlobalVisibility(
			buildTourGraph(state.steps),
			state.showGlobals
		);
		this.view.webview.postMessage({
			type: 'updateGraph',
			graph,
			currentId: state.steps[state.currentIndex]?.id ?? null,
		});
	}

	private getHtml(webview: vscode.Webview): string {
		const nonce = getNonce();
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>MENTOR Graph</title>
	<style>
		body {
			font-family: var(--vscode-font-family);
			color: var(--vscode-foreground);
			padding: 8px;
		}
		svg {
			width: 100%;
			height: 100%;
		}
		.node {
			cursor: pointer;
		}
		.node rect {
			fill: var(--vscode-editor-background);
			stroke: var(--vscode-input-border);
			rx: 6px;
		}
		.node text {
			fill: var(--vscode-foreground);
			font-size: 11px;
		}
		.node.operation rect {
			stroke: var(--vscode-charts-blue, #3b82f6);
		}
		.node.definition rect {
			stroke: var(--vscode-charts-orange, #f59e0b);
		}
		.node.global rect {
			stroke: #22c55e;
		}
		.node.active rect {
			stroke-width: 2px;
		}
		.edge {
			stroke: var(--vscode-descriptionForeground);
			stroke-width: 1px;
		}
		.edge.op-to-def {
			stroke: var(--vscode-charts-blue, #3b82f6);
		}
		.edge.def-to-def {
			stroke: var(--vscode-charts-orange, #f59e0b);
		}
	</style>
</head>
<body>
	<svg id="graph"></svg>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const svg = document.getElementById('graph');

		function layout(graph) {
			const colWidth = 170;
			const rowHeight = 54;
			const padding = 12;
			const opNodes = graph.nodes.filter(n => n.kind === 'operation');
			const defNodes = graph.nodes.filter(n => n.kind === 'definition');
			const unknownNodes = graph.nodes.filter(n => n.kind === 'unknown');
			const columns = [opNodes, defNodes, unknownNodes].filter(c => c.length > 0);
			const positions = new Map();
			let maxRows = 0;
			columns.forEach((column, colIndex) => {
				maxRows = Math.max(maxRows, column.length);
				column.forEach((node, rowIndex) => {
					const x = padding + colIndex * colWidth;
					const y = padding + rowIndex * rowHeight;
					positions.set(node.id, { x, y });
				});
			});
			const width = padding * 2 + colWidth * columns.length;
			const height = padding * 2 + rowHeight * Math.max(1, maxRows);
			return { positions, width, height };
		}

		function render(graph, currentId) {
			svg.innerHTML = '';
			const { positions, width, height } = layout(graph);
			svg.setAttribute('viewBox', \`0 0 \${width} \${height}\`);

			for (const edge of graph.edges) {
				const from = positions.get(edge.from);
				const to = positions.get(edge.to);
				if (!from || !to) continue;
				const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
				line.setAttribute('x1', from.x + 140);
				line.setAttribute('y1', from.y + 20);
				line.setAttribute('x2', to.x);
				line.setAttribute('y2', to.y + 20);
				line.setAttribute('class', \`edge \${edge.type}\`);
				svg.appendChild(line);
			}

			for (const node of graph.nodes) {
				if (node.hidden) {
					continue;
				}
				const pos = positions.get(node.id);
				if (!pos) continue;
				const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
				group.setAttribute('class', \`node \${node.kind} \${node.id === currentId ? 'active' : ''}\`);
				group.addEventListener('click', () => {
					vscode.postMessage({ type: 'selectStep', id: node.id });
				});
				const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
				rect.setAttribute('x', pos.x);
				rect.setAttribute('y', pos.y);
				rect.setAttribute('width', 140);
				rect.setAttribute('height', 40);
				group.appendChild(rect);
				const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
				label.setAttribute('x', pos.x + 6);
				label.setAttribute('y', pos.y + 16);
				label.textContent = node.label;
				group.appendChild(label);
				const meta = document.createElementNS('http://www.w3.org/2000/svg', 'text');
				meta.setAttribute('x', pos.x + 6);
				meta.setAttribute('y', pos.y + 32);
				meta.textContent = node.filePath.split('/').pop() + ':' + node.startLine;
				group.appendChild(meta);
				svg.appendChild(group);
			}
		}

		window.addEventListener('message', event => {
			const message = event.data;
			if (message && message.type === 'updateGraph') {
				render(message.graph, message.currentId);
			}
		});
	</script>
</body>
</html>`;
	}
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

function applyGlobalVisibility(
	graph: ReturnType<typeof buildTourGraph>,
	showGlobals: boolean
): ReturnType<typeof buildTourGraph> {
	if (showGlobals) {
		return graph;
	}
	const nodes = graph.nodes.map(node =>
		node.elementKind === 'global' ? { ...node, hidden: true } : node
	);
	const hiddenIds = new Set(
		nodes.filter(node => node.hidden).map(node => node.id)
	);
	const edges = graph.edges.filter(
		edge => !hiddenIds.has(edge.from) && !hiddenIds.has(edge.to)
	);
	return {
		...graph,
		nodes,
		edges,
	};
}
