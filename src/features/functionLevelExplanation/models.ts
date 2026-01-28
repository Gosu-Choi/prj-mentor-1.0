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
	changeKind?: 'definition' | 'operation' | 'global';
	changeType?: 'add' | 'remove' | 'modify' | 'unknown';
	definitionName?: string;
	definitionType?: string;
	introducedDefinitions?: Array<{
		name: string;
		type: string;
		range: LineRange;
	}>;
	backgroundRegions?: CodeRegion[];
	relatedCalls?: Array<{
		name: string;
		qualifiedName?: string;
		range: LineRange;
	}>;
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
	showGlobals: boolean;
}

export interface ChangeUnitGroup {
	id: string;
	filePath: string;
	symbolName?: string;
	range: LineRange;
	units: ChangeUnit[];
}
