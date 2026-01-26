import { TourState, TourStep } from '../functionLevelExplanation/models';

type Listener = (state: TourState) => void;

export class TourController {
	private steps: TourStep[] = [];
	private currentIndex = -1;
	private status: TourState['status'] = 'idle';
	private showBackground = true;
	private listeners = new Set<Listener>();

	setSteps(steps: TourStep[]): void {
		this.steps = steps;
		this.currentIndex = -1;
		this.status = 'idle';
		this.emit();
	}

	updateExplanations(
		explanations: Map<string, string>,
		placeholder: string
	): void {
		for (const step of this.steps) {
			const key = `${step.type}|${step.target.filePath}|${step.target.range.startLine}-${step.target.range.endLine}`;
			step.explanation = explanations.get(key) ?? placeholder;
		}
		this.emit();
	}

	start(): void {
		if (this.steps.length === 0) {
			this.status = 'completed';
			this.currentIndex = -1;
			this.emit();
			return;
		}
		this.status = 'running';
		this.currentIndex = this.findNextIndex(-1, 1);
		this.emit();
	}

	next(): void {
		if (this.status !== 'running') {
			return;
		}
		const nextIndex = this.findNextIndex(this.currentIndex, 1);
		if (nextIndex < 0) {
			this.status = 'completed';
			this.emit();
			return;
		}
		this.currentIndex = nextIndex;
		this.emit();
	}

	previous(): void {
		if (this.status !== 'running') {
			return;
		}
		const prevIndex = this.findNextIndex(this.currentIndex, -1);
		if (prevIndex < 0) {
			this.currentIndex = this.findNextIndex(-1, 1);
		} else {
			this.currentIndex = prevIndex;
		}
		this.emit();
	}

	stop(): void {
		this.status = 'idle';
		this.currentIndex = -1;
		this.emit();
	}

	getState(): TourState {
		return {
			steps: this.steps,
			currentIndex: this.currentIndex,
			status: this.status,
			showBackground: this.showBackground,
		};
	}

	getCurrentStep(): TourStep | undefined {
		if (this.currentIndex < 0 || this.currentIndex >= this.steps.length) {
			return undefined;
		}
		return this.steps[this.currentIndex];
	}

	onDidChange(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	setShowBackground(value: boolean): void {
		this.showBackground = value;
		if (this.status === 'running') {
			const current = this.getCurrentStep();
			if (current && current.type === 'background' && !value) {
				this.currentIndex = this.findNextIndex(this.currentIndex, 1);
			}
		}
		this.emit();
	}

	toggleShowBackground(): void {
		this.setShowBackground(!this.showBackground);
	}

	private findNextIndex(start: number, direction: 1 | -1): number {
		let index = start + direction;
		while (index >= 0 && index < this.steps.length) {
			const step = this.steps[index];
			if (this.showBackground || step.type !== 'background') {
				return index;
			}
			index += direction;
		}
		return -1;
	}

	private emit(): void {
		const state = this.getState();
		for (const listener of this.listeners) {
			listener(state);
		}
	}
}
