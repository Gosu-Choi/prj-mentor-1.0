import { TourState, TourStep } from './models';

type Listener = (state: TourState) => void;

export class TourController {
	private steps: TourStep[] = [];
	private currentIndex = -1;
	private status: TourState['status'] = 'idle';
	private listeners = new Set<Listener>();

	setSteps(steps: TourStep[]): void {
		this.steps = steps;
		this.currentIndex = -1;
		this.status = 'idle';
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
		this.currentIndex = 0;
		this.emit();
	}

	next(): void {
		if (this.status !== 'running') {
			return;
		}
		if (this.currentIndex + 1 >= this.steps.length) {
			this.status = 'completed';
			this.emit();
			return;
		}
		this.currentIndex += 1;
		this.emit();
	}

	previous(): void {
		if (this.status !== 'running') {
			return;
		}
		if (this.currentIndex <= 0) {
			this.currentIndex = 0;
			this.emit();
			return;
		}
		this.currentIndex -= 1;
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

	private emit(): void {
		const state = this.getState();
		for (const listener of this.listeners) {
			listener(state);
		}
	}
}
