import type {
	StageId,
	StageDefinition,
	StageDependency,
	TransitionFn,
	DAGMutator,
} from "./types.js";

export class MutableDAG implements DAGMutator {
	private readonly stages = new Map<StageId, StageDefinition>();
	private readonly deps: StageDependency[] = [];
	private readonly childrenOf = new Map<StageId, StageId[]>();
	private readonly parentsOf = new Map<StageId, StageId[]>();
	private readonly edgeMap = new Map<string, StageDependency>();

	addStage(stage: StageDefinition): void {
		if (this.stages.has(stage.id)) {
			throw new Error(`Stage "${stage.id}" already exists`);
		}
		this.stages.set(stage.id, stage);
		if (!this.childrenOf.has(stage.id)) this.childrenOf.set(stage.id, []);
		if (!this.parentsOf.has(stage.id)) this.parentsOf.set(stage.id, []);
	}

	addDependency(
		parentId: StageId,
		childId: StageId,
		transition?: TransitionFn,
	): void {
		const key = edgeKey(parentId, childId);
		if (this.edgeMap.has(key)) {
			throw new Error(`Dependency ${key} already exists`);
		}
		if (!this.stages.has(parentId)) {
			throw new Error(`Parent stage "${parentId}" not in DAG`);
		}
		if (!this.stages.has(childId)) {
			throw new Error(`Child stage "${childId}" not in DAG`);
		}
		const dep: StageDependency = {
			parentStageId: parentId,
			childStageId: childId,
			transition,
		};
		this.deps.push(dep);
		this.childrenOf.get(parentId)!.push(childId);
		this.parentsOf.get(childId)!.push(parentId);
		this.edgeMap.set(key, dep);
	}

	getStage(id: StageId): StageDefinition | undefined {
		return this.stages.get(id);
	}

	getStageIds(): StageId[] {
		return [...this.stages.keys()];
	}

	getParentStageIds(stageId: StageId): StageId[] {
		return this.parentsOf.get(stageId) ?? [];
	}

	getChildStageIds(stageId: StageId): StageId[] {
		return this.childrenOf.get(stageId) ?? [];
	}

	getRootStageIds(): StageId[] {
		return this.getStageIds().filter(
			(id) => this.getParentStageIds(id).length === 0,
		);
	}

	getLeafStageIds(): StageId[] {
		return this.getStageIds().filter(
			(id) => this.getChildStageIds(id).length === 0,
		);
	}

	getDependency(
		parentId: StageId,
		childId: StageId,
	): StageDependency | undefined {
		return this.edgeMap.get(edgeKey(parentId, childId));
	}

	getChildDependencies(stageId: StageId): StageDependency[] {
		return this.getChildStageIds(stageId)
			.map((childId) => this.getDependency(stageId, childId)!)
			.filter(Boolean);
	}

	getAllDependencies(): StageDependency[] {
		return [...this.deps];
	}

	get size(): number {
		return this.stages.size;
	}

	static fromDefinition(
		stages: StageDefinition[],
		dependencies: StageDependency[],
	): MutableDAG {
		const dag = new MutableDAG();
		for (const stage of stages) {
			dag.addStage(stage);
		}
		for (const dep of dependencies) {
			dag.addDependency(dep.parentStageId, dep.childStageId, dep.transition);
		}
		return dag;
	}
}

function edgeKey(parentId: StageId, childId: StageId): string {
	return `${parentId}->${childId}`;
}
