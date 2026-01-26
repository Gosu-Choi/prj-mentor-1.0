export interface LineRange {
	startLine: number;
	endLine: number;
}

export interface ChangeUnit {
	filePath: string;
	range: LineRange;
	diffText: string;
	symbolName?: string;
	semanticGroupId?: string;
	backgroundRegions?: CodeRegion[];
}

export interface CodeRegion {
	filePath: string;
	range: LineRange;
	label?: string;
}

export type TourStepType = 'background' | 'main';

export interface TourStep {
	id: string;
	type: TourStepType;
	target: ChangeUnit | CodeRegion;
	explanation: string;
	dependsOn?: TourStep[];
}

export interface TourState {
	steps: TourStep[];
	currentIndex: number;
	status: 'idle' | 'running' | 'paused' | 'completed';
	showBackground: boolean;
}

export interface ChangeUnitGroup {
	id: string;
	filePath: string;
	symbolName?: string;
	range: LineRange;
	units: ChangeUnit[];
}
