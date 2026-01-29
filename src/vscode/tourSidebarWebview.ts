import * as vscode from 'vscode';
import * as path from 'path';
import { TourController } from '../features/tour/tourController';
import { buildTourGraph } from '../features/tour/tourGraph';
import { TourStep } from '../features/functionLevelExplanation/models';

export class TourSidebarWebviewProvider
	implements vscode.WebviewViewProvider, vscode.Disposable
{
	private readonly disposables: vscode.Disposable[] = [];
	private readonly debugChannel = vscode.window.createOutputChannel(
		'MENTOR Graph Debug'
	);
	private view?: vscode.WebviewView;
	private unsubscribe?: () => void;

	constructor(
		private readonly controller: TourController,
		private readonly extensionUri: vscode.Uri
	) {
		this.unsubscribe = this.controller.onDidChange(() => {
			this.update();
		});
	}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		const webview = webviewView.webview;
		webview.options = {
			enableScripts: true,
		};
		webview.html = this.getHtml(webview);

		const subscription = webview.onDidReceiveMessage(async message => {
			if (!message || typeof message !== 'object') {
				return;
			}
			switch (message.type) {
				case 'start':
					await vscode.commands.executeCommand('mentor.startTour');
					break;
				case 'stop':
					this.controller.stop();
					break;
				case 'next':
					this.controller.next();
					break;
				case 'previous':
					this.controller.previous();
					break;
				case 'toggleBackground':
					this.controller.toggleShowBackground();
					break;
				case 'toggleGlobals':
					this.controller.toggleShowGlobals();
					break;
				case 'toggleOverall':
					await vscode.commands.executeCommand('mentor.toggleOverallView');
					break;
				case 'clear':
					await vscode.commands.executeCommand('mentor.clearExplanations');
					break;
				case 'debug':
					await vscode.commands.executeCommand('mentor.showDebugInfo');
					break;
				case 'debugGraph':
					this.showGraphDebug(message);
					break;
				case 'selectStep':
					if (typeof message.id === 'string') {
						this.controller.jumpToStep(message.id);
					}
					break;
				default:
					break;
			}
		});

		this.disposables.push(subscription);
		this.update();
	}

	dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.disposables.length = 0;
		this.unsubscribe?.();
		this.debugChannel.dispose();
	}

	private update(): void {
		if (!this.view) {
			return;
		}
		const state = this.controller.getState();
		const step = this.controller.getCurrentStep();
		const graph = applyGlobalVisibility(
			applyOverallVisibility(
				buildTourGraph(this.controller.getGraphSteps()),
				state.overallMode
			),
			state.showGlobals
		);
		this.view.webview.postMessage({
			type: 'update',
			status: state.status,
			showBackground: state.showBackground,
			showGlobals: state.showGlobals,
			overallMode: state.overallMode,
			currentIndex: state.currentIndex,
			total: state.steps.length,
			stepLabel: step ? formatStepLabel(state.currentIndex, state.steps.length, step) : 'No active step.',
			explanation: step?.explanation ?? '',
			graph,
			currentId: step?.id ?? null,
		});
	}

	private getHtml(webview: vscode.Webview): string {
		const nonce = getNonce();
		const visUri = webview.asWebviewUri(
			vscode.Uri.joinPath(
				this.extensionUri,
				'node_modules',
				'vis-network',
				'standalone',
				'umd',
				'vis-network.min.js'
			)
		);
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>MENTOR Tour</title>
	<style>
		body {
			font-family: var(--vscode-font-family);
			color: var(--vscode-foreground);
			padding: 10px;
		}
		.controls {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 6px;
		}
		button {
			padding: 6px 8px;
			border-radius: 4px;
			border: 1px solid var(--vscode-button-border, transparent);
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			cursor: pointer;
		}
		button.secondary {
			background: var(--vscode-button-secondaryBackground);
			color: var(--vscode-button-secondaryForeground);
		}
		button.danger {
			background: var(--vscode-inputValidation-errorBackground);
			color: var(--vscode-inputValidation-errorForeground);
		}
		.status {
			margin-top: 8px;
			font-size: 12px;
			opacity: 0.8;
		}
		.graph {
			margin-top: 6px;
			border: 1px solid var(--vscode-input-border);
			border-radius: 6px;
			padding: 6px;
			height: min(70vh, 520px);
			min-height: 260px;
			resize: vertical;
			overflow: hidden;
			position: relative;
		}
		#graph {
			width: 100%;
			height: 100%;
		}
		.step-list {
			position: absolute;
			top: 8px;
			right: 8px;
			background: var(--vscode-editor-background);
			border: 1px solid var(--vscode-input-border);
			border-radius: 6px;
			padding: 8px;
			min-width: 180px;
			max-width: 260px;
			max-height: 60%;
			overflow: auto;
			box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
			z-index: 2;
		}
		.step-list.hidden {
			display: none;
		}
		.step-list h4 {
			margin: 0 0 6px 0;
			font-size: 12px;
		}
		.step-list button {
			width: 100%;
			text-align: left;
			margin-bottom: 6px;
		}
		.step-list .close {
			display: block;
			margin-top: 4px;
			font-size: 11px;
			opacity: 0.8;
			background: transparent;
			border: none;
			color: var(--vscode-foreground);
			cursor: pointer;
		}
	</style>
</head>
<body>
	<div class="controls">
		<button id="start">Start</button>
		<button id="stop" class="secondary">Stop</button>
		<button id="prev">Previous</button>
		<button id="next">Next</button>
		<button id="toggle" class="secondary">Toggle Background</button>
		<button id="toggleGlobals" class="secondary">Toggle Globals</button>
		<button id="toggleOverall" class="secondary">Toggle Overall</button>
		<button id="clear" class="danger">Clear Explanations</button>
		<button id="debug" class="secondary">Debug Info</button>
	</div>
	<div class="status" id="status"></div>
	<div class="graph">
		<div id="graph"></div>
		<div id="stepList" class="step-list hidden"></div>
	</div>
	<script nonce="${nonce}" src="${visUri}"></script>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const statusEl = document.getElementById('status');
		const graphEl = document.getElementById('graph');
		const stepListEl = document.getElementById('stepList');
		let network = null;
		let currentGraph = null;
		const savedPositionsByKey = new Map();
		let lastNodeKeyById = new Map();
		let groupDragActive = false;
		let groupDragNodes = [];
		let groupDragLast = null;

		document.getElementById('start').addEventListener('click', () => vscode.postMessage({ type: 'start' }));
		document.getElementById('stop').addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
		document.getElementById('prev').addEventListener('click', () => vscode.postMessage({ type: 'previous' }));
		document.getElementById('next').addEventListener('click', () => vscode.postMessage({ type: 'next' }));
		document.getElementById('toggle').addEventListener('click', () => vscode.postMessage({ type: 'toggleBackground' }));
		document.getElementById('toggleGlobals').addEventListener('click', () => vscode.postMessage({ type: 'toggleGlobals' }));
		document.getElementById('toggleOverall').addEventListener('click', () => vscode.postMessage({ type: 'toggleOverall' }));
		document.getElementById('clear').addEventListener('click', () => vscode.postMessage({ type: 'clear' }));
		document.getElementById('debug').addEventListener('click', () => {
			if (network && currentGraph) {
				const positions = network.getPositions();
				const nodes = (currentGraph.nodes || []).map(node => {
					const pos = positions[node.id] || {};
					return {
						id: node.id,
						key: buildNodeKey(node),
						layoutKey: node.layoutKey,
						identityKey: node.identityKey,
						label: node.label,
						filePath: node.filePath,
						isOverall: node.isOverall,
						hidden: node.hidden === true,
						x: typeof pos.x === 'number' ? pos.x : node.x,
						y: typeof pos.y === 'number' ? pos.y : node.y
					};
				});
				vscode.postMessage({
					type: 'debugGraph',
					nodes,
					total: nodes.length
				});
			}
			vscode.postMessage({ type: 'debug' });
		});

		function renderGraph(graph, currentId) {
			currentGraph = graph;
			if (network) {
				const positions = network.getPositions();
				Object.entries(positions).forEach(([id, pos]) => {
					const key = lastNodeKeyById.get(id);
					if (!key) return;
					savedPositionsByKey.set(key, { x: pos.x, y: pos.y });
				});
			}

			const visibleIds = new Set(
				graph.nodes.filter(node => !node.hidden).map(node => node.id)
			);
			const nodeKeyById = new Map();
			const nodes = graph.nodes.map(node => {
				const key = buildNodeKey(node);
				nodeKeyById.set(node.id, key);
				const pos = savedPositionsByKey.get(key);
				const isCurrent = node.id === currentId || (node.steps || []).some(step => step.id === currentId);
				const color = node.kind === 'definition'
					? '#f59e0b'
					: node.kind === 'global'
						? '#22c55e'
						: node.kind === 'operation'
							? '#3b82f6'
							: '#6b7280';
				return {
					id: node.id,
					label: node.kind === 'operation' && !node.isOverall ? '' : node.label,
					hidden: node.hidden === true,
					filePath: node.filePath,
					elementKind: node.elementKind,
					qualifiedName: node.qualifiedName,
					isOverall: node.isOverall,
					identityKey: node.identityKey,
					layoutKey: node.layoutKey,
					color,
					font: { color: 'var(--vscode-foreground)', size: 11 },
					borderWidth: isCurrent ? 2 : 1,
					shape: 'dot',
					size: node.id === currentId ? 14 : 10,
					x: pos ? pos.x : undefined,
					y: pos ? pos.y : undefined,
					fixed: false,
					steps: node.steps
				};
			});
			const colorById = new Map(
				nodes.map(node => [node.id, node.color])
			);
			const edges = graph.edges
				.filter(edge => visibleIds.has(edge.from) && visibleIds.has(edge.to))
				.map(edge => ({
					from: edge.from,
					to: edge.to,
					color: graph.nodes.find(node => node.id === edge.to && node.isOverall === true)
						? colorById.get(edge.to)
						: edge.type === 'def-to-def'
							? '#f59e0b'
							: '#3b82f6',
					arrows: 'to'
				}));
			currentGraph = { nodes, edges };

			const previousView = network ? network.getViewPosition() : null;
			const previousScale = network ? network.getScale() : null;
			const data = {
				nodes: new vis.DataSet(nodes),
				edges: new vis.DataSet(edges)
			};

			if (!network) {
				network = new vis.Network(graphEl, data, {
					layout: {
						improvedLayout: true
					},
					interaction: {
						hover: true,
						tooltipDelay: 120
					},
					physics: {
						enabled: false,
						solver: 'barnesHut',
						barnesHut: {
							gravitationalConstant: -1200,
							centralGravity: 0.32,
							springLength: 80,
							springConstant: 0.05,
							damping: 0.6,
							avoidOverlap: 0.6
						},
						stabilization: {
							iterations: 250,
							fit: false
						}
					},
					edges: {
						smooth: false
					}
				});
				network.on('click', params => {
					if (params.nodes && params.nodes.length > 0) {
						const nodeId = params.nodes[0];
						const node = (currentGraph?.nodes || []).find(entry => entry.id === nodeId);
						if (node && node.steps && node.steps.length > 1) {
							showStepList(node.steps);
							return;
						}
						hideStepList();
						const stepId = node?.steps?.[0]?.id ?? nodeId;
						vscode.postMessage({ type: 'selectStep', id: stepId });
					}
				});
				network.on('dragEnd', params => {
					if (!params || !params.nodes) return;
					const positions = network.getPositions(params.nodes);
					Object.entries(positions).forEach(([id, pos]) => {
						const key = nodeKeyById.get(id);
						if (!key) return;
						savedPositionsByKey.set(key, { x: pos.x, y: pos.y });
					});
				});
				network.on('oncontext', params => {
					if (!params || !params.event) return;
					params.event.preventDefault();
					const nodeId = params.nodes && params.nodes.length > 0
						? params.nodes[0]
						: null;
					if (!nodeId) {
						groupDragActive = false;
						groupDragNodes = [];
						groupDragLast = null;
						return;
					}
					groupDragNodes = buildConnectedGroup(nodeId, currentGraph);
					groupDragActive = groupDragNodes.length > 0;
					groupDragLast = params.pointer?.canvas ?? null;
					if (groupDragActive) {
						network.selectNodes(groupDragNodes, true);
					}
				});
				network.on('mousemove', params => {
					if (!groupDragActive || !groupDragLast) return;
					const buttons = params.event?.buttons ?? 0;
					if ((buttons & 2) !== 2) return;
					const next = params.pointer?.canvas;
					if (!next) return;
					const dx = next.x - groupDragLast.x;
					const dy = next.y - groupDragLast.y;
					if (dx === 0 && dy === 0) return;
					groupDragLast = next;
					groupDragNodes.forEach(id => {
						const pos = network.getPositions([id])[id];
						if (pos) {
							network.moveNode(id, pos.x + dx, pos.y + dy);
						}
					});
				});
				network.on('mouseup', () => {
					groupDragActive = false;
					groupDragNodes = [];
					groupDragLast = null;
				});
				graphEl.addEventListener('contextmenu', event => {
					event.preventDefault();
				});
				document.addEventListener('mouseup', event => {
					if (event.button !== 2) return;
					groupDragActive = false;
					groupDragNodes = [];
					groupDragLast = null;
				});
			} else {
				network.setOptions({ physics: { enabled: false } });
				network.setData(data);
				if (previousView && previousScale) {
					network.moveTo({
						position: previousView,
						scale: previousScale,
						animation: false
					});
				}
			}
			lastNodeKeyById = nodeKeyById;
		}

		function showStepList(steps) {
			stepListEl.classList.remove('hidden');
			stepListEl.innerHTML = '';
			const title = document.createElement('h4');
			title.textContent = 'Changes in this element';
			stepListEl.appendChild(title);
			steps.forEach(step => {
				const button = document.createElement('button');
				button.textContent = step.label;
				button.addEventListener('click', () => {
					hideStepList();
					vscode.postMessage({ type: 'selectStep', id: step.id });
				});
				stepListEl.appendChild(button);
			});
			const close = document.createElement('button');
			close.textContent = 'Close';
			close.className = 'close';
			close.addEventListener('click', () => hideStepList());
			stepListEl.appendChild(close);
		}

		function hideStepList() {
			stepListEl.classList.add('hidden');
			stepListEl.innerHTML = '';
		}

		function buildNodeKey(node) {
			if (node.layoutKey) {
				return node.layoutKey;
			}
			if (node.identityKey) {
				return node.identityKey;
			}
			const label = node.label ?? '';
			const elementKind = node.elementKind ?? '';
			const qualified = node.qualifiedName ?? '';
			const identity = qualified || label;
			return node.filePath + '|' + elementKind + '|' + identity;
		}

		function buildConnectedGroup(nodeId, graph) {
			if (!graph || !graph.edges) return [nodeId];
			const neighbors = new Map();
			graph.edges.forEach(edge => {
				if (!neighbors.has(edge.from)) neighbors.set(edge.from, new Set());
				if (!neighbors.has(edge.to)) neighbors.set(edge.to, new Set());
				neighbors.get(edge.from).add(edge.to);
				neighbors.get(edge.to).add(edge.from);
			});
			const visited = new Set([nodeId]);
			const queue = [nodeId];
			while (queue.length > 0) {
				const current = queue.shift();
				const nexts = neighbors.get(current);
				if (!nexts) continue;
				nexts.forEach(next => {
					if (!visited.has(next)) {
						visited.add(next);
						queue.push(next);
					}
				});
			}
			return Array.from(visited);
		}


		window.addEventListener('message', event => {
			const message = event.data;
			if (!message || message.type !== 'update') return;
			statusEl.textContent = \`Status: \${message.status} | Background: \${message.showBackground ? 'on' : 'off'} | Globals: \${message.showGlobals ? 'on' : 'off'} | Overall: \${message.overallMode ? 'on' : 'off'} | \${message.stepLabel}\`;
			renderGraph(message.graph, message.currentId);
		});
	</script>
</body>
</html>`;
	}

	private showGraphDebug(message: {
		nodes?: Array<{
			id: string;
			key?: string;
			layoutKey?: string;
			identityKey?: string;
			label?: string;
			filePath?: string;
			isOverall?: boolean;
			hidden?: boolean;
			x?: number;
			y?: number;
		}>;
		total?: number;
	}): void {
		const nodes = message.nodes ?? [];
		this.debugChannel.clear();
		this.debugChannel.appendLine('MENTOR Graph Debug');
		this.debugChannel.appendLine(`Nodes: ${message.total ?? nodes.length}`);
		for (const node of nodes) {
			const key = node.key ?? '';
			const layoutKey = node.layoutKey ?? '';
			const identityKey = node.identityKey ?? '';
			const label = node.label ?? '';
			const file = node.filePath ?? '';
			const overall = node.isOverall ? 'overall' : 'diff';
			const hidden = node.hidden ? 'hidden' : 'visible';
			const x = typeof node.x === 'number' ? node.x.toFixed(2) : 'n/a';
			const y = typeof node.y === 'number' ? node.y.toFixed(2) : 'n/a';
			this.debugChannel.appendLine(
				`${node.id} | ${key} | ${layoutKey} | ${identityKey} | ${file} | ${label} | ${overall} | ${hidden} | (${x}, ${y})`
			);
		}
		this.debugChannel.show(true);
	}
}

function formatStepLabel(
	index: number,
	total: number,
	step: TourStep
): string {
	return `${step.type.toUpperCase()} ${index + 1} / ${total}`;
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
	return {
		...graph,
		nodes,
	};
}

function applyOverallVisibility(
	graph: ReturnType<typeof buildTourGraph>,
	overallMode: boolean
): ReturnType<typeof buildTourGraph> {
	const nodes = graph.nodes.map(node => {
		const isOverall = node.isOverall === true;
		const hidden = overallMode ? !isOverall : isOverall;
		return hidden ? { ...node, hidden: true } : node;
	});
	return {
		...graph,
		nodes,
	};
}
